/**
 * The pure half of `pnpm smoke:transactional`: argument parsing, the request
 * bodies it sends, and the assertions it applies to each response.
 *
 * No `node:*` imports and no I/O, so every judgement the smoke test makes can
 * be unit-tested in the Workers Vitest pool (tests/unit/smoke-transactional.test.ts).
 * The side-effecting runner is scripts/smoke-transactional.ts.
 *
 * Why this exists: the unit/integration suites call the mailbox Durable Object
 * directly, so four bugs on the real operator + integrator path (a 500 that lost
 * the plaintext key, a From display name never sent, wildcard recipient policies
 * that never matched, a UI 401) shipped with every test green. This smoke test
 * drives a DEPLOYED environment through the same HTTP surface a person uses.
 *
 * The plaintext API key is a live credential: nothing in this module ever puts
 * it in evidence, and `redactSecrets` exists for any response body that might.
 */
import { normalizeHost, originFor, redact } from "./operator-session-core";

export class SmokeInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SmokeInputError";
	}
}

export const DEFAULT_SENDER_NAME = "Reccado smoke";
/** An address the key's recipient policy cannot match; `.invalid` is reserved (RFC 2606). */
export const POLICY_REJECT_ADDRESS = "smoke-reject@example.invalid";
/** The throwaway key's lifetime and send quota: small enough that a leaked key is nearly inert. */
export const KEY_TTL_MS = 60 * 60 * 1000;
export const KEY_QUOTA_MAX = 5;
export const MAX_WAIT_DELIVERY_SECONDS = 3600;
export const KEY_SCOPES = [
	"transactional:send",
	"transactional:templates:use",
	"transactional:status",
] as const;

export type SmokeOptions = {
	env?: string;
	host?: string;
	mailboxId: string;
	sender: string;
	to: string;
	senderName: string;
	send: boolean;
	waitDeliverySeconds: number;
	help: boolean;
};

export const SMOKE_USAGE = `Usage: pnpm smoke:transactional --mailbox <mailboxId> --sender <addr> --to <recipient>
                                [--env dev] [--host <host>] [--sender-name "Reccado smoke"]
                                [--send] [--wait-delivery <seconds>]
  Without --send: checks the operator session and that the mailbox answers, prints the plan, sends nothing.
  With --send:    creates a throwaway template + live key (1h, quota ${KEY_QUOTA_MAX}, policy = --to),
                  sends ONE real message to --to, replays it, proves policy rejection, reads status,
                  then always revokes the key and archives the template.
  --wait-delivery N  poll the status up to N seconds (max ${MAX_WAIT_DELIVERY_SECONDS}) for a delivery event.
                     Skipped with a WARN when --to is a verified Email Routing destination address on
                     the account (those sends never produce an event). The check reads the account's
                     destination addresses with CLOUDFLARE_API_TOKEN (Account · Email Routing
                     Addresses · Read) and CLOUDFLARE_ACCOUNT_ID or \`wrangler whoami\`.
  Sign in first: pnpm operator login --env <env> --host <host>`;

const BOOLEAN_FLAGS = new Set(["send", "help"]);
const VALUE_FLAGS = new Set([
	"env",
	"host",
	"mailbox",
	"sender",
	"to",
	"sender-name",
	"wait-delivery",
]);
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const MAILBOX_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function assertEmail(flag: string, value: string): string {
	const trimmed = value.trim();
	if (!EMAIL_RE.test(trimmed)) {
		throw new SmokeInputError(`--${flag} must be an email address, got "${value}".`);
	}
	return trimmed;
}

/**
 * Parses argv. Unknown flags are refused rather than ignored: a typo in
 * `--send` must not silently turn a plan-only run into a real one or vice versa.
 */
export function parseSmokeArgs(argv: readonly string[]): SmokeOptions {
	const flags: Record<string, string> = {};
	const bools = new Set<string>();
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg) continue;
		if (!arg.startsWith("--")) {
			throw new SmokeInputError(`Unexpected argument "${arg}".`);
		}
		const eq = arg.indexOf("=");
		const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		if (BOOLEAN_FLAGS.has(key)) {
			if (eq !== -1) throw new SmokeInputError(`--${key} takes no value.`);
			bools.add(key);
			continue;
		}
		if (!VALUE_FLAGS.has(key)) {
			throw new SmokeInputError(`Unknown flag --${key}.`);
		}
		let value: string | undefined;
		if (eq !== -1) {
			value = arg.slice(eq + 1);
		} else {
			value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new SmokeInputError(`--${key} needs a value.`);
			}
			i += 1;
		}
		flags[key] = value;
	}

	const help = bools.has("help");
	if (help) {
		return {
			mailboxId: "",
			sender: "",
			to: "",
			senderName: DEFAULT_SENDER_NAME,
			send: false,
			waitDeliverySeconds: 0,
			help: true,
		};
	}

	const missing = ["mailbox", "sender", "to"].filter((k) => !flags[k]?.trim());
	if (missing.length > 0) {
		throw new SmokeInputError(`Missing required ${missing.map((k) => `--${k}`).join(", ")}.`);
	}
	const mailboxId = (flags.mailbox ?? "").trim();
	if (!MAILBOX_ID_RE.test(mailboxId)) {
		throw new SmokeInputError(`--mailbox must be a mailbox id like mbx_..., got "${mailboxId}".`);
	}
	const sender = assertEmail("sender", flags.sender ?? "");
	const to = assertEmail("to", flags.to ?? "");
	if (to.toLowerCase() === POLICY_REJECT_ADDRESS) {
		throw new SmokeInputError(`--to cannot be ${POLICY_REJECT_ADDRESS}; that is the policy probe.`);
	}
	const senderName = (flags["sender-name"] ?? DEFAULT_SENDER_NAME).trim();
	if (!senderName) throw new SmokeInputError("--sender-name cannot be empty.");

	let waitDeliverySeconds = 0;
	if (flags["wait-delivery"] !== undefined) {
		const raw = flags["wait-delivery"].trim();
		const n = Number(raw);
		if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n > MAX_WAIT_DELIVERY_SECONDS) {
			throw new SmokeInputError(
				`--wait-delivery must be an integer 0-${MAX_WAIT_DELIVERY_SECONDS}, got "${raw}".`,
			);
		}
		waitDeliverySeconds = n;
	}

	return {
		env: flags.env?.trim() || undefined,
		host: flags.host?.trim() ? normalizeHost(flags.host) : undefined,
		mailboxId,
		sender,
		to,
		senderName,
		send: bools.has("send"),
		waitDeliverySeconds,
		help: false,
	};
}

// --- The run's identifiers and request bodies ---

export type SmokeRunIds = {
	/** Template id; matches the send path's `^[a-zA-Z_][a-zA-Z0-9_.-]*$`. */
	templateId: string;
	/** Unique token placed in the subject (literal) and the body (via `{{token}}`). */
	token: string;
	/** Idempotency-Key for the real send and its replay. */
	idempotencyKey: string;
	/** A different Idempotency-Key for the policy probe. */
	rejectIdempotencyKey: string;
};

/** `randomHex` must be at least 8 hex chars of fresh randomness (the runner passes 16). */
export function makeRunIds(nowMs: number, randomHex: string): SmokeRunIds {
	if (!/^[0-9a-f]{8,}$/.test(randomHex)) {
		throw new SmokeInputError("makeRunIds needs at least 8 lowercase hex characters.");
	}
	const token = `${nowMs.toString(36)}${randomHex.slice(0, 8)}`;
	return {
		templateId: `smoke-${nowMs}`,
		token,
		idempotencyKey: `smoke-${token}-send`,
		rejectIdempotencyKey: `smoke-${token}-reject`,
	};
}

export function buildTemplateBody(ids: SmokeRunIds) {
	return {
		id: ids.templateId,
		subject: `Reccado smoke test ${ids.token}`,
		body_text:
			"This is an automated Reccado transactional smoke test.\n\n" +
			"Token: {{token}}\n\nNo action is needed.",
		body_html:
			"<p>This is an automated Reccado transactional smoke test.</p>" +
			"<p>Token: <code>{{token}}</code></p><p>No action is needed.</p>",
	};
}

export function buildKeyBody(input: {
	sender: string;
	to: string;
	templateId: string;
	nowMs: number;
}) {
	return {
		environment: "live" as const,
		sender: input.sender,
		scopes: [...KEY_SCOPES],
		templateAllowlist: [input.templateId],
		// Exactly the one recipient: the key cannot mail anyone else even if it leaks.
		recipientPolicy: input.to,
		quotaMax: KEY_QUOTA_MAX,
		expiresAt: new Date(input.nowMs + KEY_TTL_MS).toISOString(),
	};
}

export function buildSendPayload(ids: SmokeRunIds, to: string) {
	return { template: ids.templateId, to, variables: { token: ids.token } };
}

/** URL + init for an integrator call to the public `/v1` surface, Bearer-authenticated. */
export function buildIntegratorRequest(input: {
	host: string;
	mailboxId: string;
	apiKey: string;
	method: "POST" | "GET";
	requestId?: string;
	idempotencyKey?: string;
	body?: unknown;
}): { url: string; init: RequestInit } {
	const base = `${originFor(input.host)}/v1/mailboxes/${encodeURIComponent(input.mailboxId)}/transactional/messages`;
	const url = input.requestId ? `${base}/${encodeURIComponent(input.requestId)}` : base;
	const headers: Record<string, string> = {
		authorization: `Bearer ${input.apiKey}`,
		accept: "application/json",
	};
	if (input.method === "POST") {
		if (!input.idempotencyKey) {
			throw new SmokeInputError("A transactional send needs an Idempotency-Key.");
		}
		headers["content-type"] = "application/json";
		headers["idempotency-key"] = input.idempotencyKey;
	}
	return {
		url,
		init: {
			method: input.method,
			headers,
			redirect: "manual",
			...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
		},
	};
}

export function mailboxApiPath(mailboxId: string, suffix: string): string {
	return `/api/mailboxes/${encodeURIComponent(mailboxId)}/transactional${suffix}`;
}

// --- Responses and step results ---

export type HttpResult = { status: number; body: unknown; text: string };

/** Parses a response body; a non-JSON body yields `body: undefined` and keeps `text`. */
export function toHttpResult(status: number, text: string): HttpResult {
	let body: unknown;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = undefined;
	}
	return { status, body, text };
}

export type StepOutcome = "PASS" | "FAIL" | "WARN" | "INFO" | "SKIP";

export type StepResult = {
	name: string;
	outcome: StepOutcome;
	evidence: string[];
};

export function step(name: string, outcome: StepOutcome, evidence: string[] = []): StepResult {
	return { name, outcome, evidence };
}

export function formatStep(result: StepResult): string {
	const lines = [`[${result.outcome}] ${result.name}`];
	for (const line of result.evidence) lines.push(`       ${line}`);
	return lines.join("\n");
}

/** Replaces each secret (the plaintext key, the cookie) with `[redacted]`. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
	return redact(text, secrets);
}

/** A short, secret-free rendering of an unexpected response for evidence. */
export function describeResponse(
	result: HttpResult,
	secrets: readonly (string | undefined)[] = [],
): string {
	const text = redactSecrets(result.text, secrets).replace(/\s+/g, " ").trim();
	return `HTTP ${result.status} ${text.length > 300 ? `${text.slice(0, 300)}...` : text}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export type KeyView = {
	keyId: string;
	status?: string;
	senderName: string | null;
	sender?: string;
	environment?: string;
	recipientPolicy?: string | null;
	quotaUsed?: number;
	quotaMax?: number | null;
	displaySuffix?: string;
	expiresAt?: string | null;
};

function toKeyView(value: unknown): KeyView | undefined {
	const r = record(value);
	const keyId = str(r?.keyId);
	if (!r || !keyId) return undefined;
	return {
		keyId,
		status: str(r.status),
		senderName: typeof r.senderName === "string" ? r.senderName : null,
		sender: str(r.sender),
		environment: str(r.environment),
		recipientPolicy: typeof r.recipientPolicy === "string" ? r.recipientPolicy : null,
		quotaUsed: typeof r.quotaUsed === "number" ? r.quotaUsed : undefined,
		quotaMax: typeof r.quotaMax === "number" ? r.quotaMax : null,
		displaySuffix: str(r.displaySuffix),
		expiresAt: typeof r.expiresAt === "string" ? r.expiresAt : null,
	};
}

/**
 * The key out of a key-admin response, whichever envelope it came in:
 * create answers `{ key, plaintextKey, projection }`; PATCH and revoke answer
 * `{ key: { key, projection } }`.
 */
export function extractKey(body: unknown): KeyView | undefined {
	const outer = record(body);
	const key = record(outer?.key);
	return (
		toKeyView(key?.key) ??
		toKeyView(key?.projection) ??
		toKeyView(key) ??
		toKeyView(outer?.projection)
	);
}

export function keyEvidence(key: KeyView): string {
	return [
		`keyId=${key.keyId}`,
		key.displaySuffix ? `suffix=...${key.displaySuffix}` : undefined,
		key.environment ? `env=${key.environment}` : undefined,
		key.status ? `status=${key.status}` : undefined,
		key.sender ? `sender=${key.sender}` : undefined,
		key.recipientPolicy ? `policy=${key.recipientPolicy}` : undefined,
		key.quotaMax != null ? `quotaMax=${key.quotaMax}` : undefined,
		key.expiresAt ? `expires=${key.expiresAt}` : undefined,
	]
		.filter(Boolean)
		.join(" ");
}

/** Step 2a — the regression for the lost-key bug: 201 AND a plaintext key in the body. */
export function assessKeyCreate(result: HttpResult): {
	step: StepResult;
	keyId?: string;
	plaintextKey?: string;
} {
	const outer = record(result.body);
	const plaintextKey = str(outer?.plaintextKey);
	const key = extractKey(result.body);
	const secrets = [plaintextKey];
	const name = "create live key";
	if (result.status !== 201) {
		return {
			step: step(name, "FAIL", [`expected 201, got ${describeResponse(result, secrets)}`]),
			keyId: key?.keyId,
			plaintextKey,
		};
	}
	const evidence = [
		"HTTP 201",
		plaintextKey
			? `plaintextKey: present (${plaintextKey.length} chars, not shown)`
			: "plaintextKey: MISSING from the 201 body (the key is unusable and unrecoverable)",
	];
	if (key) evidence.push(keyEvidence(key));
	else evidence.push("no key id in the response");
	const ok =
		Boolean(plaintextKey) &&
		Boolean(key) &&
		key?.environment !== "test" &&
		key?.status !== "revoked";
	return { step: step(name, ok ? "PASS" : "FAIL", evidence), keyId: key?.keyId, plaintextKey };
}

/** The keys array out of `GET .../api-keys` (`{ keys: [...] }`). */
export function extractKeyList(body: unknown): KeyView[] | undefined {
	const keys = record(body)?.keys;
	if (!Array.isArray(keys)) return undefined;
	return keys.map(toKeyView).filter((k): k is KeyView => Boolean(k));
}

export function findKey(body: unknown, keyId: string): KeyView | undefined {
	return extractKeyList(body)?.find((k) => k.keyId === keyId);
}

/** Step 2b — the new key is visible to the list endpoint. */
export function assessKeyListed(result: HttpResult, keyId: string): StepResult {
	const name = "key appears in GET api-keys";
	if (result.status !== 200) return step(name, "FAIL", [describeResponse(result)]);
	const list = extractKeyList(result.body);
	if (!list) return step(name, "FAIL", [`no keys array: ${describeResponse(result)}`]);
	const key = list.find((k) => k.keyId === keyId);
	if (!key) return step(name, "FAIL", [`${keyId} not among ${list.length} key(s)`]);
	return step(name, key.status === "active" ? "PASS" : "FAIL", [keyEvidence(key)]);
}

/** Step 3 — PATCH senderName answered 2xx and the key (as re-read) carries it. */
export function assessSenderName(
	patch: HttpResult,
	listed: HttpResult | undefined,
	keyId: string,
	expected: string,
): StepResult {
	const name = "set sender name";
	if (patch.status < 200 || patch.status >= 300) {
		return step(name, "FAIL", [`PATCH: ${describeResponse(patch)}`]);
	}
	const fromPatch = extractKey(patch.body)?.senderName ?? null;
	const evidence = [`PATCH HTTP ${patch.status}, senderName=${JSON.stringify(fromPatch)}`];
	let fromList: string | null | undefined;
	if (listed) {
		fromList =
			listed.status === 200 ? (findKey(listed.body, keyId)?.senderName ?? null) : undefined;
		evidence.push(
			listed.status === 200
				? `GET api-keys senderName=${JSON.stringify(fromList)}`
				: `GET api-keys: ${describeResponse(listed)}`,
		);
	}
	const ok = fromPatch === expected && (listed === undefined || fromList === expected);
	if (!ok) evidence.push(`expected ${JSON.stringify(expected)}`);
	return step(name, ok ? "PASS" : "FAIL", evidence);
}

export type SendView = {
	status?: string;
	requestId?: string;
	keyId?: string;
	providerMessageId?: string | null;
	error?: string;
};

export function extractSend(body: unknown): SendView {
	const r = record(body);
	return {
		status: str(r?.status),
		requestId: str(r?.requestId),
		keyId: str(r?.keyId),
		providerMessageId: typeof r?.providerMessageId === "string" ? r.providerMessageId : null,
		error: str(r?.error),
	};
}

function sendEvidence(result: HttpResult, view: SendView): string {
	return [
		`HTTP ${result.status}`,
		`status=${view.status ?? "?"}`,
		view.requestId ? `requestId=${view.requestId}` : undefined,
		view.providerMessageId ? `providerMessageId=${view.providerMessageId}` : undefined,
		view.error ? `error=${view.error}` : undefined,
	]
		.filter(Boolean)
		.join(" ");
}

/** Step 4 — a real send: 200, `sent`, a request id and a provider message id. */
export function assessSend(
	result: HttpResult,
	secrets: readonly (string | undefined)[] = [],
): {
	step: StepResult;
	send: SendView;
} {
	const view = extractSend(result.body);
	const name = "send (integrator, Bearer key)";
	const ok =
		result.status === 200 &&
		view.status === "sent" &&
		Boolean(view.requestId) &&
		Boolean(view.providerMessageId);
	const evidence = [sendEvidence(result, view)];
	if (!ok && result.body === undefined) evidence.push(describeResponse(result, secrets));
	if (!ok && view.status === "unknown") {
		evidence.push(
			"outcome unknown: do NOT resend with a new Idempotency-Key; check the recipient mailbox",
		);
	}
	return { step: step(name, ok ? "PASS" : "FAIL", evidence), send: view };
}

/**
 * Step 5 — a replay with the same Idempotency-Key and payload. The DO answers
 * it from the stored request row without reaching the provider, so it must
 * return the ORIGINAL requestId and providerMessageId with status `sent` (or
 * `duplicate`). A request that reached the provider again would carry a fresh
 * requestId (`crypto.randomUUID()` on the new-request path) and a new provider
 * message id, so matching ids are the proof that nothing was sent twice.
 *
 * Not used as proof: `quotaUsed` from GET api-keys. `listApiKeys` reports a
 * constant 0 rather than the live usage counter, so it cannot show a double charge.
 */
export function assessReplay(original: SendView, replay: HttpResult): StepResult {
	const view = extractSend(replay.body);
	const evidence = [sendEvidence(replay, view)];
	const sameRequest = Boolean(original.requestId) && view.requestId === original.requestId;
	const sameProvider =
		Boolean(original.providerMessageId) && view.providerMessageId === original.providerMessageId;
	evidence.push(
		sameRequest && sameProvider
			? "same requestId and providerMessageId as the original: answered from the idempotency row, not re-sent"
			: `expected requestId=${original.requestId} providerMessageId=${original.providerMessageId}`,
	);
	const ok =
		replay.status === 200 &&
		(view.status === "sent" || view.status === "duplicate") &&
		sameRequest &&
		sameProvider;
	return step("idempotent replay", ok ? "PASS" : "FAIL", evidence);
}

/** Step 6 — an off-policy recipient is refused before anything is reserved or sent. */
export function assessPolicyRejection(result: HttpResult): StepResult {
	const view = extractSend(result.body);
	const ok =
		result.status === 403 &&
		view.status === "rejected" &&
		view.error === "not_allowed_by_policy" &&
		!view.requestId &&
		!view.providerMessageId;
	const evidence = [sendEvidence(result, view)];
	if (!ok) evidence.push('expected HTTP 403 {"status":"rejected","error":"not_allowed_by_policy"}');
	return step(`recipient policy rejects ${POLICY_REJECT_ADDRESS}`, ok ? "PASS" : "FAIL", evidence);
}

export type StatusView = {
	status?: string;
	providerMessageId?: string | null;
	deliveryStatus: string | null;
	deliveryEventAt: string | null;
	resolvedVia: string | null;
	feedbackState: string;
	feedbackReason: string | null;
};

export function extractStatus(body: unknown): StatusView {
	const r = record(body);
	const feedback = record(r?.deliveryFeedback);
	return {
		status: str(r?.status),
		providerMessageId: typeof r?.providerMessageId === "string" ? r.providerMessageId : null,
		deliveryStatus: typeof r?.deliveryStatus === "string" ? r.deliveryStatus : null,
		deliveryEventAt: typeof r?.deliveryEventAt === "string" ? r.deliveryEventAt : null,
		resolvedVia: typeof r?.resolvedVia === "string" ? r.resolvedVia : null,
		feedbackState: str(feedback?.state) ?? "absent",
		feedbackReason: typeof feedback?.reason === "string" ? feedback.reason : null,
	};
}

/** Delivery statuses after which no further event is expected for the message. */
const TERMINAL_DELIVERY = new Set(["delivered", "bounced", "complained", "rejected", "failed"]);
const BAD_DELIVERY = new Set(["bounced", "complained", "rejected", "failed"]);

export function isTerminalDelivery(view: StatusView): boolean {
	return view.deliveryStatus !== null && TERMINAL_DELIVERY.has(view.deliveryStatus);
}

export function feedbackEvidence(view: StatusView): string {
	return `deliveryFeedback=${view.feedbackState}${view.feedbackReason ? ` (${view.feedbackReason})` : ""}`;
}

/** Step 7a — the status endpoint knows the request and agrees it was sent. */
export function assessStatus(result: HttpResult, send: SendView): StepResult {
	const name = "status (GET /v1/.../messages/:requestId)";
	if (result.status !== 200) return step(name, "FAIL", [describeResponse(result)]);
	const view = extractStatus(result.body);
	const evidence = [
		`status=${view.status ?? "?"} providerMessageId=${view.providerMessageId ?? "null"}`,
		`deliveryStatus=${view.deliveryStatus ?? "null"} deliveryEventAt=${view.deliveryEventAt ?? "null"}${view.resolvedVia ? ` resolvedVia=${view.resolvedVia}` : ""}`,
		feedbackEvidence(view),
	];
	const ok = view.status === "sent" && view.providerMessageId === (send.providerMessageId ?? null);
	return step(name, ok ? "PASS" : "FAIL", evidence);
}

// --- Email Routing destination addresses ---

export type RoutingDestination = { email: string; verified: boolean };

/**
 * The account's Email Routing destination addresses out of
 * `GET /accounts/{account_id}/email/routing/addresses` (`result`). An address
 * counts as verified when its `verified` timestamp is set; one still awaiting its
 * confirmation click is not a destination yet.
 */
export function parseRoutingDestinations(result: unknown): RoutingDestination[] {
	if (!Array.isArray(result)) return [];
	const destinations: RoutingDestination[] = [];
	for (const entry of result) {
		const r = record(entry);
		const email = str(r?.email);
		if (!email) continue;
		destinations.push({
			email: email.trim().toLowerCase(),
			verified: typeof r?.verified === "string" && r.verified.length > 0,
		});
	}
	return destinations;
}

export type RoutingLookup =
	| { ok: true; destinations: RoutingDestination[] }
	| { ok: false; reason: string };

/**
 * Decides whether waiting for a delivery event can mean anything for `--to`.
 *
 * When the recipient is a verified Email Routing destination address on the
 * account, Cloudflare's `send_email` binding delivers through Email Routing, and
 * Email Routing produces no Email Sending lifecycle event at all: account
 * analytics showed every such send only as an Email Routing `newEmail`, never in
 * Email Sending. Waiting would then time out and read as a missing event for a
 * message that was delivered. So the wait is skipped with a WARN, not a FAIL.
 *
 * A failed lookup does not block the wait: it only means the guard could not run.
 */
export function assessRoutingDestination(
	to: string,
	lookup: RoutingLookup,
): { skipWait: boolean; step: StepResult } {
	const name = "recipient vs Email Routing destination addresses";
	if (!lookup.ok) {
		return {
			skipWait: false,
			step: step(name, "INFO", [
				`could not read the account's Email Routing destination addresses: ${lookup.reason}`,
				"waiting anyway; if --to is a verified destination address, no delivery event will arrive",
			]),
		};
	}
	const recipient = to.trim().toLowerCase();
	const match = lookup.destinations.find((d) => d.email === recipient && d.verified);
	if (!match) {
		return {
			skipWait: false,
			step: step(name, "INFO", [
				`${to} is not a verified destination address (${lookup.destinations.length} on the account); delivery events are expected`,
			]),
		};
	}
	return {
		skipWait: true,
		step: step(name, "WARN", [
			`${to} is a verified Email Routing destination address on this account`,
			"send_email delivers to it through Email Routing, which never produces an Email Sending lifecycle event",
			"skipping the delivery wait: no event will arrive, and deliveryFeedback may read unobserved for this send without anything being wrong",
			"to exercise delivery events, send to an address that is not a destination address on this account",
		]),
	};
}

/**
 * Step 7b — the delivery verdict after waiting. Absence of an event is only a
 * failure when the domain's feedback channel is demonstrably live; otherwise
 * silence says nothing about the message (AGENTS.md, src/lib/feedback-liveness.ts).
 */
export function assessDelivery(view: StatusView, waitedSeconds: number): StepResult {
	const name = "delivery event";
	if (view.deliveryStatus !== null) {
		const evidence = [
			`deliveryStatus=${view.deliveryStatus} at ${view.deliveryEventAt ?? "?"}`,
			feedbackEvidence(view),
		];
		if (view.deliveryStatus === "delivered") return step(name, "PASS", ["delivered", ...evidence]);
		if (BAD_DELIVERY.has(view.deliveryStatus)) return step(name, "FAIL", evidence);
		return step(name, "WARN", [`non-terminal event after ${waitedSeconds}s`, ...evidence]);
	}
	const evidence = [
		`no event within ${waitedSeconds} s (check the domain's feedback liveness: ${feedbackEvidence(view)})`,
	];
	if (view.feedbackState === "live") {
		evidence.push("the feedback channel is live, so a missing event is a real signal");
		return step(name, "FAIL", evidence);
	}
	evidence.push("feedback liveness is not live, so silence is not evidence about this message");
	return step(name, "WARN", evidence);
}

/** Step 8 — revoke answered 2xx and the key now reads revoked. */
export function assessRevoke(result: HttpResult): StepResult {
	const key = extractKey(result.body);
	const ok = result.status === 200 && key?.status === "revoked";
	return step("cleanup: revoke key", ok ? "PASS" : "FAIL", [
		ok && key ? keyEvidence(key) : describeResponse(result),
	]);
}

export function assessArchive(result: HttpResult, templateId: string): StepResult {
	const ok = result.status === 200 && record(result.body)?.ok === true;
	return step("cleanup: archive template", ok ? "PASS" : "FAIL", [
		ok ? `template ${templateId} archived` : describeResponse(result),
	]);
}

/**
 * Commands to finish the cleanup by hand. They read the cookie from the
 * operator's own session file at run time, so it is never printed.
 */
export function manualCleanupCommands(input: {
	host: string;
	env?: string;
	mailboxId: string;
	keyId?: string;
	templateId?: string;
	sessionPath: string;
}): string[] {
	const origin = originFor(input.host);
	const auth = `-H "origin: ${origin}" -H "cookie: $(jq -r .cookie '${input.sessionPath}')"`;
	const lines = [
		`# if the session expired first: pnpm operator login${input.env ? ` --env ${input.env}` : ""} --host ${input.host}`,
	];
	if (input.keyId) {
		lines.push(
			`curl -sS -X POST ${auth} ${origin}${mailboxApiPath(input.mailboxId, `/api-keys/${input.keyId}/revoke`)}`,
		);
	}
	if (input.templateId) {
		lines.push(
			`curl -sS -X POST ${auth} ${origin}${mailboxApiPath(input.mailboxId, `/templates/${input.templateId}/archive`)}`,
		);
	}
	return lines;
}

export function hasFailure(results: readonly StepResult[]): boolean {
	return results.some((r) => r.outcome === "FAIL");
}

export function summaryLine(results: readonly StepResult[]): string {
	const count = (o: StepOutcome) => results.filter((r) => r.outcome === o).length;
	return `RESULT: ${hasFailure(results) ? "FAIL" : "PASS"} (${count("PASS")} pass, ${count("FAIL")} fail, ${count("WARN")} warn, ${count("SKIP")} skipped)`;
}

/** The plan printed before anything happens (and the whole output of a plan-only run). */
export function planLines(opts: SmokeOptions, host: string, ids: SmokeRunIds): string[] {
	return [
		`Transactional smoke test against ${originFor(host)} (mailbox ${opts.mailboxId})`,
		`  mode:      ${opts.send ? "SEND — one real message will be sent" : "plan only (no --send): read-only checks, nothing is created or sent"}`,
		`  sender:    ${opts.senderName} <${opts.sender}>`,
		`  recipient: ${opts.to}`,
		"  steps:",
		`    1. create template ${ids.templateId} (subject token ${ids.token}, {{token}} in bodies)`,
		`    2. create LIVE key: scopes ${KEY_SCOPES.join(",")}, allowlist [${ids.templateId}], policy "${opts.to}", quota ${KEY_QUOTA_MAX}, expires in 1h; assert 201 + plaintextKey, listed`,
		`    3. PATCH senderName "${opts.senderName}"; assert the key reports it`,
		`    4. send to ${opts.to} (Idempotency-Key ${ids.idempotencyKey}); assert sent + providerMessageId`,
		"    5. replay with the same Idempotency-Key; assert same requestId + providerMessageId (no second send)",
		`    6. send to ${POLICY_REJECT_ADDRESS} (same key, new Idempotency-Key); assert rejected not_allowed_by_policy`,
		`    7. read status + deliveryFeedback${opts.waitDeliverySeconds > 0 ? `; wait up to ${opts.waitDeliverySeconds}s for a delivery event` : ""}`,
		"    8. always: revoke the key, archive the template",
	];
}

export function manualCheckLine(
	opts: SmokeOptions,
	ids: SmokeRunIds,
	providerMessageId: string | null | undefined,
): string {
	return (
		`Manual check: open the message in ${opts.to}'s mailbox (subject "${buildTemplateBody(ids).subject}"` +
		`${providerMessageId ? `, provider id ${providerMessageId}` : ""}) and confirm From reads ` +
		`"${opts.senderName} <${opts.sender}>" and the headers show SPF, DKIM and DMARC pass ` +
		"(the display name is not observable through the API)."
	);
}
