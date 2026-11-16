/**
 * Human approval of an agent-originated action (owner-session web click on `/approve/:id`).
 *
 * The mailbox Durable Object remains the send authority. This module mints an
 * unguessable intent, renders only the frozen snapshot, and — after a human
 * approval bound to that exact intent (id + payload_hash) — consumes the row once and hands the DO
 * a short-lived proof. No other caller can make an `mcp` draft send.
 *
 * Exported for the next task (the MCP `send` tool), which must not grow a second
 * copy of this:
 * - `createIntent`
 * - `getIntentStatus`
 * - `buildApprovalUrl`
 * - `notifyIntentCreated` lives in `src/telegram/notify.ts` and calls `buildApprovalUrl`.
 */

import {
	type ApprovalRow,
	consumeApproval,
	getApproval,
	getOutboundSendByIntentId,
	insertApprovalIntent,
	insertOpsEvent,
	listDomains,
	type OutboundSendRow,
} from "../db/d1";
import { AdminError } from "./admin/errors";
import {
	canonicalJson,
	controlPlaneKind,
	hashPayload,
	ownerForUser,
} from "./control-plane-intents";
import { renderWithSafetyNet } from "./control-plane-registry";
import { hmacSha256 } from "./crypto";
import { domainFromAddress } from "./email-headers";
import { getSendingFeedbackStatus } from "./feedback-liveness";
import { mailboxStub } from "./mailbox-stub";
import { confirmDraftSend } from "./outbound-send";
import { classifySensitive } from "./sensitive-mail";

export { registerControlPlaneKind, requestControlPlaneChange } from "./control-plane-intents";

const MCP_TTL_MS = 10 * 60 * 1000;
const PROOF_TTL_MS = 60 * 1000;

export type IntentStatusName =
	| "pending"
	| "approved"
	| "sent"
	| "denied"
	| "expired"
	| "stale"
	| "executed"
	| "failed";

/**
 * `text` (default) is a short line, `pre` is long/verbatim content shown in a scrollable
 * monospace block (never rendered as HTML), `list` is newline-separated items.
 */
export type IntentFieldFormat = "text" | "pre" | "list";
export type IntentField = { label: string; value: string; format?: IntentFieldFormat };
/** `address` names the recipient a per-recipient warning is about (send warnings only). */
export type IntentWarning = { code: string; message: string; address?: string };

export type IntentStatus = {
	status: IntentStatusName;
	send: {
		status: string;
		providerMessageId: string | null;
		errorCode: string | null;
	} | null;
	deliveryFeedback: { domain: string | null; state: string } | null;
	result?: {
		items: Array<{
			status: "executed" | "failed" | "not_run";
			result?: unknown;
			errorCode?: string;
		}>;
	} | null;
};

export type IntentView = {
	id: string;
	kind: string;
	status: IntentStatusName;
	title: string;
	fields: IntentField[];
	warnings: IntentWarning[];
	payloadHash: string | null;
	expiresAt: string | null;
};

/** Approval is web-only: the owner session on `/approve/:id`. Telegram only notifies. */
export type ApprovalChannel = "web";

export type McpApprovalProof = {
	intentId: string;
	payloadHash: string;
	exp: number;
	sig: string;
};

export type FrozenSend = {
	payloadHash: string;
	stale: boolean;
	snapshot: Record<string, unknown>;
	seenAddresses: string[];
};

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function randomId(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64url(bytes);
}

/**
 * HMAC key for the proof the DO checks. The auth secret wins when it is
 * configured. Tests leave that secret unset, so the local debug token is the
 * key only in that case — a configured auth secret is never interchangeable
 * with the debug token.
 */
export function approvalProofSecret(env: {
	BETTER_AUTH_SECRET?: string;
	PHASE0_DEBUG_TOKEN?: string;
}): string | null {
	const auth = env.BETTER_AUTH_SECRET?.trim();
	if (auth && auth.length >= 32) return auth;
	if (!auth) {
		const debug = env.PHASE0_DEBUG_TOKEN?.trim();
		if (debug && debug.length >= 16) return `debug:${debug}`;
	}
	return null;
}

function proofMessage(input: {
	intentId: string;
	mailboxId: string;
	draftId: string;
	payloadHash: string;
	exp: number;
}): string {
	return [
		"mcp-approval.v1",
		"passkey",
		input.intentId,
		input.mailboxId,
		input.draftId,
		input.payloadHash,
		String(input.exp),
	].join("\n");
}

export async function signMcpApprovalProof(
	secret: string,
	input: {
		intentId: string;
		mailboxId: string;
		draftId: string;
		payloadHash: string;
		exp: number;
	},
): Promise<McpApprovalProof> {
	const mac = await hmacSha256(secret, proofMessage(input));
	return {
		intentId: input.intentId,
		payloadHash: input.payloadHash,
		exp: input.exp,
		sig: base64url(mac),
	};
}

export async function verifyMcpApprovalProof(
	secret: string,
	input: McpApprovalProof & { mailboxId: string; draftId: string },
	now = Date.now(),
): Promise<boolean> {
	if (!Number.isFinite(input.exp) || input.exp <= now || input.exp > now + 2 * PROOF_TTL_MS) {
		return false;
	}
	const expected = await signMcpApprovalProof(secret, input);
	return timingSafeEqual(expected.sig, input.sig);
}

export function buildApprovalUrl(origin: string, intentId: string): string | null {
	const url = new URL(`/approve/${encodeURIComponent(intentId)}`, origin);
	if (url.origin !== origin || (url.protocol !== "https:" && url.hostname !== "localhost")) {
		return null;
	}
	return url.toString();
}

function bounded(value: string | null | undefined, max: number): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > max) return null;
	return trimmed;
}

export async function createIntent(
	env: Env,
	input: {
		kind: string;
		origin: "mcp" | "web" | "telegram";
		mailboxId: string;
		draftId: string;
		payloadHash: string;
		oauthClientId?: string | null;
		tokenSub?: string | null;
		tokenJti?: string | null;
	},
): Promise<{ id: string; expiresAt: string; kind: string; payloadHash: string }> {
	if (!/^[a-z][a-z0-9_]{0,31}$/.test(input.kind)) {
		throw new Error("invalid_intent_kind");
	}
	if (!/^[a-f0-9]{64}$/.test(input.payloadHash)) {
		throw new Error("invalid_payload_hash");
	}
	if (!input.mailboxId || !input.draftId) throw new Error("invalid_intent_target");
	const id = randomId();
	const expiresAt = new Date(Date.now() + MCP_TTL_MS).toISOString();
	await insertApprovalIntent(env.INDEX_DB, {
		token: id,
		kind: input.kind,
		origin: input.origin,
		mailboxId: input.mailboxId,
		draftId: input.draftId,
		payloadHash: input.payloadHash,
		expiresAt,
		oauthClientId: bounded(input.oauthClientId, 2048),
		tokenSub: bounded(input.tokenSub, 512),
		tokenJti: bounded(input.tokenJti, 512),
	});
	await recordEvent(env, id, "approval.created", {
		kind: input.kind,
		origin: input.origin,
		mailboxId: input.mailboxId,
		draftId: input.draftId,
		payloadHash: input.payloadHash,
	});
	return { id, expiresAt, kind: input.kind, payloadHash: input.payloadHash };
}

/** Atomically share the one live MCP send approval for a draft. */
export async function getOrCreatePendingIntent(
	env: Env,
	input: {
		kind: "send";
		origin: "mcp";
		mailboxId: string;
		draftId: string;
		payloadHash: string;
		oauthClientId?: string | null;
		tokenSub?: string | null;
		tokenJti?: string | null;
	},
): Promise<{ intent: { id: string; expiresAt: string; payloadHash: string }; created: boolean }> {
	if (!input.mailboxId || !input.draftId || !/^[a-f0-9]{64}$/.test(input.payloadHash))
		throw new Error("invalid_intent_target");
	const now = new Date().toISOString();
	const id = randomId();
	const expiresAt = new Date(Date.now() + MCP_TTL_MS).toISOString();
	await env.INDEX_DB.prepare(
		`UPDATE approvals SET consumed_at = ? WHERE kind = 'send' AND origin = 'mcp' AND mailbox_id = ? AND draft_id = ? AND consumed_at IS NULL AND decision IS NULL AND expires_at <= ?`,
	)
		.bind(now, input.mailboxId, input.draftId, now)
		.run();
	const inserted = await env.INDEX_DB.prepare(
		`INSERT INTO approvals (token, kind, origin, mailbox_id, draft_id, payload_hash, created_at, expires_at, oauth_client_id, token_sub, token_jti) VALUES (?, 'send', 'mcp', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
	)
		.bind(
			id,
			input.mailboxId,
			input.draftId,
			input.payloadHash,
			now,
			expiresAt,
			bounded(input.oauthClientId, 2048),
			bounded(input.tokenSub, 512),
			bounded(input.tokenJti, 512),
		)
		.run();
	const row = await env.INDEX_DB.prepare(
		`SELECT token, expires_at, payload_hash FROM approvals WHERE kind = 'send' AND origin = 'mcp' AND mailbox_id = ? AND draft_id = ? AND consumed_at IS NULL AND decision IS NULL`,
	)
		.bind(input.mailboxId, input.draftId)
		.first<{ token: string; expires_at: string; payload_hash: string }>();
	if (!row) throw new Error("intent_unavailable");
	const created = (inserted.meta?.changes ?? 0) === 1;
	if (created)
		await recordEvent(env, id, "approval.created", {
			kind: input.kind,
			origin: input.origin,
			mailboxId: input.mailboxId,
			draftId: input.draftId,
			payloadHash: input.payloadHash,
		});
	return {
		intent: { id: row.token, expiresAt: row.expires_at, payloadHash: row.payload_hash },
		created,
	};
}

async function recordEvent(
	env: Env,
	id: string,
	eventType: string,
	payload: Record<string, unknown>,
): Promise<void> {
	await insertOpsEvent(env.INDEX_DB, {
		id: `${eventType}:${id}`,
		event_type: eventType,
		severity: "info",
		subject: id,
		payload_json: JSON.stringify(payload),
	}).catch(() => undefined);
}

function sendOutcome(row: OutboundSendRow | null): IntentStatus["send"] {
	if (!row) return null;
	return {
		status: row.status,
		providerMessageId: row.provider_message_id,
		errorCode: row.error_code,
	};
}

async function feedbackFor(
	env: Env,
	fromAddress: string | null,
): Promise<IntentStatus["deliveryFeedback"]> {
	const domain = fromAddress ? domainFromAddress(fromAddress) : null;
	if (!domain) return { domain: null, state: "unobserved" };
	try {
		const status = await getSendingFeedbackStatus(env.INDEX_DB);
		const match = status.domains.find((item) => item.domain === domain);
		return { domain, state: match?.state ?? "unobserved" };
	} catch {
		return { domain, state: "unobserved" };
	}
}

export async function readFrozen(
	env: Env,
	mailboxId: string,
	draftId: string,
): Promise<FrozenSend | null> {
	const response = await mailboxStub(env, mailboxId).fetch(
		`https://mailbox-do/drafts/${encodeURIComponent(draftId)}/send-intent`,
	);
	if (!response.ok) return null;
	const body = (await response.json()) as {
		snapshot?: Record<string, unknown>;
		payload_hash?: string;
		stale?: boolean;
		seenAddresses?: string[];
	};
	if (!body.snapshot || typeof body.payload_hash !== "string") return null;
	return {
		snapshot: body.snapshot,
		payloadHash: body.payload_hash,
		stale: body.stale === true,
		seenAddresses: Array.isArray(body.seenAddresses)
			? body.seenAddresses.filter((value): value is string => typeof value === "string")
			: [],
	};
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

/**
 * The only mail the page is allowed to show. Unknown keys — including anything
 * an agent might have stuffed in beside the snapshot — are dropped.
 */
export function fieldsFromSnapshot(snapshot: Record<string, unknown>): {
	fields: IntentField[];
	warnings: IntentWarning[];
	from: string | null;
	recipients: string[];
} {
	const identity = (snapshot.identity ?? {}) as Record<string, unknown>;
	const from = stringField(identity.from);
	const fromName = stringField(identity.fromName);
	const replyTo = stringField(identity.replyTo);
	const to = stringList(snapshot.to);
	const cc = stringList(snapshot.cc);
	const bcc = stringList(snapshot.bcc);
	const subject = stringField(snapshot.subject);
	const text = typeof snapshot.text === "string" ? snapshot.text : "";
	const html = typeof snapshot.html === "string" ? snapshot.html : "";
	const attachments = Array.isArray(snapshot.attachments) ? snapshot.attachments : [];
	const fields: IntentField[] = [{ label: "De", value: fromName ? `${fromName} <${from}>` : from }];
	if (replyTo) fields.push({ label: "Reply-To", value: replyTo });
	fields.push({ label: "Para", value: to.join(", ") });
	if (cc.length) fields.push({ label: "Cc", value: cc.join(", ") });
	if (bcc.length) fields.push({ label: "Cco", value: bcc.join(", ") });
	fields.push({ label: "Asunto", value: subject });
	fields.push({ label: "Mensaje", value: text });
	if (html) fields.push({ label: "HTML", value: html });
	if (attachments.length) {
		const hashes = attachments
			.map((item) =>
				item &&
				typeof item === "object" &&
				typeof (item as { sha256?: unknown }).sha256 === "string"
					? (item as { sha256: string }).sha256
					: "",
			)
			.filter(Boolean);
		fields.push({
			label: "Adjuntos",
			value: hashes.length ? hashes.join("\n") : String(attachments.length),
		});
	}
	return { fields, warnings: [], from: from || null, recipients: [...to, ...cc, ...bcc] };
}

async function warningsForSend(
	env: Env,
	snapshot: Record<string, unknown>,
	seenAddresses: string[],
): Promise<IntentWarning[]> {
	const { from, recipients } = fieldsFromSnapshot(snapshot);
	const identity = (snapshot.identity ?? {}) as Record<string, unknown>;
	const replyTo = stringField(identity.replyTo).trim().toLowerCase();
	const warnings: IntentWarning[] = [];
	const domains = await listDomains(env.INDEX_DB).catch(() => []);
	const hosted = new Set(
		domains
			.filter((domain) => domain.status === "active")
			.map((domain) => domain.domain.toLowerCase()),
	);
	const seen = new Set(seenAddresses.map((address) => address.trim().toLowerCase()));
	for (const recipient of recipients.slice(0, 20)) {
		const address = recipient.trim().toLowerCase();
		const domain = domainFromAddress(address);
		if (domain && !hosted.has(domain)) {
			warnings.push({
				code: "external_recipient",
				message: `El destinatario ${address} está fuera de tus dominios.`,
				address,
			});
		}
		if (address && !seen.has(address)) {
			warnings.push({
				code: "never_seen_recipient",
				message: `Nunca has intercambiado correo con ${address} en este buzón.`,
				address,
			});
		}
	}
	if (replyTo && from && replyTo !== from.trim().toLowerCase()) {
		warnings.push({
			code: "reply_to_mismatch",
			message: "Reply-To no coincide con From.",
		});
	}
	const sensitive = classifySensitive({
		from,
		subject: stringField(snapshot.subject),
		text: typeof snapshot.text === "string" ? snapshot.text : null,
		html: typeof snapshot.html === "string" ? snapshot.html : null,
	});
	if (sensitive.kind) {
		warnings.push({
			code: "sensitive_content",
			message:
				"El mensaje parece contener un secreto (código, enlace de acceso o restablecimiento). Revísalo antes de enviarlo.",
		});
	}
	return warnings;
}

type RenderInput = {
	snapshot: Record<string, unknown> | null;
	warnings: IntentWarning[];
};

const renderers: Record<string, (input: RenderInput) => { title: string; fields: IntentField[] }> =
	{
		send: (input) => ({
			title: "Revisar envío",
			fields: input.snapshot ? fieldsFromSnapshot(input.snapshot).fields : [],
		}),
	};

function renderKind(kind: string, input: RenderInput): { title: string; fields: IntentField[] } {
	return (renderers[kind] ?? (() => ({ title: "Solicitud", fields: [] })))(input);
}

function expiredStatus(): IntentStatus {
	return { status: "expired", send: null, deliveryFeedback: null };
}

export async function getIntentStatus(env: Env, id: string): Promise<IntentStatus> {
	const row = await getApproval(env.INDEX_DB, id);
	if (!row) return expiredStatus();
	if (row.kind !== "send" && controlPlaneKind(row.kind)) {
		const stored = await controlData(env, id);
		if (row.decision === "denied") return { status: "denied", send: null, deliveryFeedback: null };
		if (stored?.result_json) {
			const result = JSON.parse(stored.result_json) as NonNullable<IntentStatus["result"]>;
			return {
				status: result.items.some((item) => item.status === "failed") ? "failed" : "executed",
				send: null,
				deliveryFeedback: null,
				result,
			};
		}
		if (row.decision === "approved")
			return { status: "approved", send: null, deliveryFeedback: null };
		if (new Date(row.expires_at).getTime() <= Date.now()) return expiredStatus();
		if (
			!stored?.payload_json ||
			!row.payload_hash ||
			!(await payloadMatches(stored.payload_json, row.payload_hash))
		)
			return { status: "stale", send: null, deliveryFeedback: null };
		return { status: "pending", send: null, deliveryFeedback: null };
	}
	const send = await getOutboundSendByIntentId(env.INDEX_DB, id).catch(() => null);
	let from: string | null = null;
	let frozen: FrozenSend | null = null;
	if (row.kind === "send" && row.mailbox_id && row.draft_id) {
		frozen = await readFrozen(env, row.mailbox_id, row.draft_id).catch(() => null);
		from = frozen ? fieldsFromSnapshot(frozen.snapshot).from : null;
	}
	const deliveryFeedback = await feedbackFor(env, from);
	if (row.decision === "denied") {
		return { status: "denied", send: sendOutcome(send), deliveryFeedback };
	}
	if (send?.status === "sent") {
		return { status: "sent", send: sendOutcome(send), deliveryFeedback };
	}
	if (row.decision === "approved") {
		return { status: "approved", send: sendOutcome(send), deliveryFeedback };
	}
	if (new Date(row.expires_at).getTime() <= Date.now()) {
		await recordEvent(env, row.token, "approval.expired", { kind: row.kind });
		return { status: "expired", send: sendOutcome(send), deliveryFeedback };
	}
	if (
		row.kind === "send" &&
		(!frozen || frozen.stale || !row.payload_hash || frozen.payloadHash !== row.payload_hash)
	) {
		return { status: "stale", send: null, deliveryFeedback };
	}
	return { status: "pending", send: null, deliveryFeedback };
}

export async function getIntentView(
	env: Env,
	id: string,
	actor: { userId: string },
): Promise<IntentView> {
	return buildView(env, id, actor.userId);
}

/**
 * The same server-rendered view for the Telegram notice. There is no web session there, so
 * control-plane fields render as the owner whose token created the intent.
 */
export async function getIntentCard(env: Env, id: string): Promise<IntentView> {
	const row = await getApproval(env.INDEX_DB, id);
	return buildView(env, id, row?.token_sub ?? null);
}

async function buildView(env: Env, id: string, userId: string | null): Promise<IntentView> {
	const row = await getApproval(env.INDEX_DB, id);
	const status = await getIntentStatus(env, id);
	if (!row) {
		return {
			id,
			kind: "send",
			status: "expired",
			title: "Solicitud caducada",
			fields: [],
			warnings: [],
			payloadHash: null,
			expiresAt: null,
		};
	}
	const frozen =
		row.kind === "send" && row.mailbox_id && row.draft_id
			? await readFrozen(env, row.mailbox_id, row.draft_id).catch(() => null)
			: null;
	let warnings =
		row.kind === "send" && frozen
			? await warningsForSend(env, frozen.snapshot, frozen.seenAddresses)
			: [];
	let rendered = renderKind(row.kind, {
		snapshot: frozen?.snapshot ?? null,
		warnings,
	});
	const definition = controlPlaneKind(row.kind);
	if (definition && status.status === "pending") {
		try {
			if (!userId) throw new AdminError("Forbidden", "forbidden", 403);
			const data = await controlData(env, id);
			const actorAuth = await ownerForUser(env, userId);
			const payload: unknown = JSON.parse(data?.payload_json ?? "null");
			const part = await renderWithSafetyNet(
				definition,
				env,
				actorAuth,
				definition.validate(payload),
			);
			rendered = { title: part.title, fields: part.fields };
			warnings = part.warnings;
		} catch {
			status.status = "stale";
		}
	}
	return {
		id: row.token,
		kind: row.kind,
		status: status.status,
		title: rendered.title,
		fields: rendered.fields,
		warnings,
		payloadHash: status.status === "pending" ? row.payload_hash : null,
		expiresAt: row.expires_at,
	};
}

/**
 * Human approval of one intent.
 *
 * `payloadHash` is what the approver was shown (web page / Telegram button prefix is
 * resolved to the full hash by the caller after loading the row). It must equal the stored
 * hash, so an approval can never apply to a payload other than the one rendered. `approver`
 * is the owner's user id on the web, or the operator's Telegram user id on Telegram; the
 * caller is responsible for having authenticated it (owner session / operator allowlist).
 * The agent has no code path here: nothing reachable over MCP calls this function.
 */
export async function approveIntent(
	env: Env,
	input: {
		id: string;
		payloadHash: string;
		channel: ApprovalChannel;
		approver: string;
	},
): Promise<IntentStatus & { error?: string; reveal?: IntentField[]; resolved?: boolean }> {
	const row = await getApproval(env.INDEX_DB, input.id);
	if (!row?.payload_hash || (row.kind === "send" && (!row.mailbox_id || !row.draft_id))) {
		return { ...expiredStatus(), error: "expired" };
	}
	if (row.consumed_at || row.decision) {
		return { ...(await getIntentStatus(env, input.id)), resolved: true };
	}
	if (new Date(row.expires_at).getTime() <= Date.now()) {
		await recordEvent(env, row.token, "approval.expired", { kind: row.kind });
		return { ...(await getIntentStatus(env, input.id)), error: "expired" };
	}
	if (!timingSafeEqual(input.payloadHash, row.payload_hash)) {
		return { status: "stale", send: null, deliveryFeedback: null, error: "stale" };
	}
	// Multi-owner safety: an MCP intent is approved only by the owner whose token created it.
	if (row.token_sub && row.token_sub !== input.approver) {
		return { ...(await getIntentStatus(env, input.id)), error: "forbidden" };
	}
	// The owner a control-plane change executes as: the web approver.
	const actorUserId = input.approver;
	if (row.kind === "send") {
		const frozen = await readFrozen(env, row.mailbox_id!, row.draft_id!).catch(() => null);
		if (!frozen || frozen.stale || frozen.payloadHash !== row.payload_hash) {
			return { status: "stale", send: null, deliveryFeedback: null, error: "stale" };
		}
	} else if (controlPlaneKind(row.kind)) {
		const stored = await controlData(env, row.token);
		if (!stored?.payload_json || !(await payloadMatches(stored.payload_json, row.payload_hash)))
			return { status: "stale", send: null, deliveryFeedback: null, error: "stale" };
		try {
			if (!actorUserId) throw new AdminError("Forbidden", "forbidden", 403);
			const actor = await ownerForUser(env, actorUserId);
			const definition = controlPlaneKind(row.kind)!;
			const parsed: unknown = JSON.parse(stored.payload_json);
			await definition.render(env, actor, definition.validate(parsed));
		} catch {
			return { ...(await getIntentStatus(env, input.id)), error: "forbidden" };
		}
	} else {
		return { ...(await getIntentStatus(env, input.id)), error: "unsupported_kind" };
	}
	const won = await consumeApproval(env.INDEX_DB, row.token, "approved");
	if (!won) return { ...(await getIntentStatus(env, input.id)), resolved: true };
	await recordEvent(env, row.token, "approval.approved", {
		kind: row.kind,
		channel: input.channel,
		approver: input.approver,
		payloadHash: row.payload_hash,
		oauthClientId: row.oauth_client_id ?? null,
		tokenSub: row.token_sub ?? null,
		tokenJti: row.token_jti ?? null,
	});
	if (row.kind === "send") return dispatchSend(env, row);
	return dispatchControl(env, row, actorUserId!, {
		channel: input.channel,
		approver: input.approver,
	});
}

async function controlData(
	env: Env,
	id: string,
): Promise<{ payload_json: string | null; result_json: string | null } | null> {
	return env.INDEX_DB.prepare("SELECT payload_json, result_json FROM approvals WHERE token = ?")
		.bind(id)
		.first();
}
async function payloadMatches(json: string, hash: string): Promise<boolean> {
	try {
		return canonicalJson(JSON.parse(json)) === json && (await hashPayload(json)) === hash;
	} catch {
		return false;
	}
}
async function dispatchControl(
	env: Env,
	row: ApprovalRow,
	userId: string,
	approval: { channel: ApprovalChannel; approver: string },
): Promise<IntentStatus & { reveal?: IntentField[] }> {
	const definition = controlPlaneKind(row.kind)!;
	const stored = await controlData(env, row.token);
	if (
		!stored?.payload_json ||
		!row.payload_hash ||
		!(await payloadMatches(stored.payload_json, row.payload_hash))
	) {
		await env.INDEX_DB.prepare("UPDATE approvals SET result_json = ? WHERE token = ?")
			.bind(
				JSON.stringify({ items: [{ status: "failed", errorCode: "payload_mismatch" }] }),
				row.token,
			)
			.run();
		return getIntentStatus(env, row.token);
	}
	const parsed: unknown = JSON.parse(stored.payload_json);
	const results: NonNullable<IntentStatus["result"]>["items"] = [];
	const principal = {
		kind: row.kind,
		intent_id: row.token,
		oauth_client_id: row.oauth_client_id ?? null,
		token_sub: row.token_sub ?? null,
		token_jti: row.token_jti ?? null,
		approver_user_id: userId,
		approval_channel: approval.channel,
		approver: approval.approver,
	};
	let failed = false;
	const reveal: IntentField[] = [];
	try {
		const actor = await ownerForUser(env, userId);
		const result = await definition.execute(env, actor, definition.validate(parsed));
		// One-time secrets go only to the approving owner's HTTP response, never into result_json.
		const split = definition.redact ? definition.redact(result) : { stored: result };
		reveal.push(...(split.secrets ?? []));
		results.push({ status: "executed", result: split.stored });
	} catch (error) {
		failed = true;
		results.push({
			status: "failed",
			errorCode: error instanceof AdminError ? error.code : "execution_failed",
		});
	}
	await env.INDEX_DB.prepare("UPDATE approvals SET result_json = ? WHERE token = ?")
		.bind(JSON.stringify({ items: results }), row.token)
		.run();
	// Attribution: which client/token asked for this change and which owner approved it.
	await insertOpsEvent(env.INDEX_DB, {
		id: `approval.executed:${row.token}`,
		event_type: "approval.executed",
		severity: failed ? "warning" : "info",
		subject: row.token,
		payload_json: JSON.stringify({
			...principal,
			outcomes: results.map((item) => item.status),
		}),
	}).catch(() => undefined);
	const status = await getIntentStatus(env, row.token);
	return reveal.length ? { ...status, reveal } : status;
}

async function dispatchSend(
	env: Env,
	row: ApprovalRow,
): Promise<IntentStatus & { error?: string }> {
	if (row.kind !== "send" || !row.mailbox_id || !row.draft_id || !row.payload_hash) {
		return { ...(await getIntentStatus(env, row.token)), error: "unsupported_kind" };
	}
	const result = await confirmDraftSend(env, {
		mailboxId: row.mailbox_id,
		draftId: row.draft_id,
		attemptKey: row.token,
		approvalMode: "human_confirmed",
		expectedPayloadHash: row.payload_hash,
		approval: {
			intentId: row.token,
			payloadHash: row.payload_hash,
			oauthClientId: row.oauth_client_id ?? null,
			tokenSub: row.token_sub ?? null,
			tokenJti: row.token_jti ?? null,
		},
	});
	const status = await getIntentStatus(env, row.token);
	if (result.body.error === "intent_stale") return { ...status, status: "stale", error: "stale" };
	if (result.body.sent !== true && result.body.status !== "sent") {
		return {
			...status,
			error: typeof result.body.error === "string" ? result.body.error : "not_sent",
		};
	}
	return status.status === "sent" ? status : { ...status, status: "sent" };
}

export async function denyIntent(
	env: Env,
	id: string,
	by?: { channel: ApprovalChannel; approver: string },
): Promise<IntentStatus> {
	const row = await getApproval(env.INDEX_DB, id);
	if (!row) return expiredStatus();
	if (row.consumed_at || row.decision) return getIntentStatus(env, id);
	if (new Date(row.expires_at).getTime() <= Date.now()) {
		await recordEvent(env, row.token, "approval.expired", { kind: row.kind });
		return getIntentStatus(env, id);
	}
	const won = await consumeApproval(env.INDEX_DB, id, "denied");
	if (!won) return getIntentStatus(env, id);
	await recordEvent(env, id, "approval.denied", {
		kind: row.kind,
		channel: by?.channel ?? null,
		approver: by?.approver ?? null,
	});
	return getIntentStatus(env, id);
}
