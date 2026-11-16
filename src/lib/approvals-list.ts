/**
 * The owner's approvals queue for the inbox (`GET /api/approvals`).
 *
 * Read-only. Every pending item is rendered through `getIntentView`, the same
 * function the standalone `/approve/:id` page uses, so the queue never shows a
 * field, warning or payload hash the single-item view would not. The extra
 * `send` block is the same frozen snapshot that view renders, structured so the
 * inbox can lay it out (From/To/Subject/body) instead of parsing labels.
 *
 * Approving and denying stay on `POST /api/approvals/:id/approve|deny`; nothing
 * here changes state. Only the owner web session reaches this (see
 * `approval-routes.ts`); there is no MCP tool for it.
 */

import {
	fieldsFromSnapshot,
	getIntentView,
	type IntentField,
	type IntentStatusName,
	type IntentWarning,
	readFrozen,
} from "./approvals";
import { controlPlaneKind } from "./control-plane-intents";

const DECIDED_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 50;
const MAX_DECIDED = 20;
const SNIPPET_CHARS = 160;

export type ApprovalSendSummary = {
	mailboxId: string;
	/** The agent's draft the request freezes (owner-visible in Drafts already). */
	draftId: string;
	/** Thread the reply joins; null for a brand-new message. */
	threadId: string | null;
	/** The message being answered, when the agent pinned one. */
	parentMessageId: string | null;
	from: string | null;
	fromName: string | null;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	/** Full plain-text body (pending items only; the single view shows it too). */
	text: string | null;
	snippet: string;
	attachments: number;
};

export type ApprovalListItem = {
	id: string;
	kind: string;
	status: IntentStatusName;
	createdAt: string;
	expiresAt: string;
	/** When the owner approved or denied it; null while pending. */
	decidedAt: string | null;
	/** Name of the OAuth client that asked, when it can be resolved. */
	requestedBy: string | null;
	/** `/approve/:id`, the standalone page (and the only place a one-time secret is shown). */
	approveUrl: string;
	/** Approving reveals a one-time secret: approve on `/approve/:id`, never in the inbox. */
	revealsSecret: boolean;
	/** Server-rendered title (the approve page's heading). */
	title: string;
	/** Frozen fields and warnings exactly as the approve page renders them. Empty once decided. */
	fields: IntentField[];
	warnings: IntentWarning[];
	/** The hash to send back on approve; non-null only while the request is pending. */
	payloadHash: string | null;
	send: ApprovalSendSummary | null;
};

export type ApprovalList = {
	pending: ApprovalListItem[];
	decided: ApprovalListItem[];
	now: string;
};

type Row = {
	token: string;
	kind: string;
	mailbox_id: string | null;
	draft_id: string | null;
	created_at: string;
	expires_at: string;
	consumed_at: string | null;
	decision: string | null;
	oauth_client_id: string | null;
	result_json: string | null;
	send_status: string | null;
};

const COLUMNS = `a.token, a.kind, a.mailbox_id, a.draft_id, a.created_at, a.expires_at, a.consumed_at,
	a.decision, a.oauth_client_id, a.result_json,
	(SELECT s.status FROM outbound_sends s WHERE s.intent_id = a.token
	 ORDER BY CASE s.status WHEN 'sent' THEN 0 ELSE 1 END LIMIT 1) AS send_status`;
const FROM = `FROM approvals a`;
/** MCP requests the viewer may decide: their own token's, or ones with no recorded subject. */
const MINE = `a.origin = 'mcp' AND (a.token_sub IS NULL OR a.token_sub = ?)`;

export async function listApprovals(
	env: Env,
	userId: string,
	now = new Date(),
): Promise<ApprovalList> {
	const nowIso = now.toISOString();
	const since = new Date(now.getTime() - DECIDED_WINDOW_MS).toISOString();
	const [pendingRows, decidedRows] = await Promise.all([
		env.INDEX_DB.prepare(
			`SELECT ${COLUMNS} ${FROM}
			 WHERE ${MINE} AND a.decision IS NULL AND a.consumed_at IS NULL AND a.expires_at > ?
			 ORDER BY a.created_at ASC LIMIT ${MAX_PENDING}`,
		)
			.bind(userId, nowIso)
			.all<Row>(),
		env.INDEX_DB.prepare(
			`SELECT ${COLUMNS} ${FROM}
			 WHERE ${MINE} AND a.decision IS NOT NULL AND a.consumed_at >= ?
			 ORDER BY a.consumed_at DESC LIMIT ${MAX_DECIDED}`,
		)
			.bind(userId, since)
			.all<Row>(),
	]);
	const pending = pendingRows.results.filter(known);
	const decided = decidedRows.results.filter(known);
	const names = await clientNames(env, [...pending, ...decided]);

	const pendingItems = await Promise.all(
		pending.map(async (row) => {
			const view = await getIntentView(env, row.token, { userId });
			const send = await sendSummary(env, row, true);
			return item(row, names, {
				status: view.status,
				title: view.title,
				fields: view.fields,
				warnings: view.warnings,
				payloadHash: view.payloadHash,
				send,
			});
		}),
	);
	const decidedItems = await Promise.all(
		decided.map(async (row) =>
			item(row, names, {
				status: decidedStatus(row),
				title: "",
				fields: [],
				warnings: [],
				payloadHash: null,
				send: await sendSummary(env, row, false),
			}),
		),
	);
	return {
		// A request that stopped being pending between the query and the render drops out.
		pending: pendingItems.filter((entry) => entry.status === "pending" || entry.status === "stale"),
		decided: decidedItems,
		now: nowIso,
	};
}

function known(row: Row): boolean {
	return row.kind === "send"
		? Boolean(row.mailbox_id && row.draft_id)
		: Boolean(controlPlaneKind(row.kind));
}

function item(
	row: Row,
	names: Map<string, string>,
	rest: Pick<ApprovalListItem, "status" | "title" | "fields" | "warnings" | "payloadHash" | "send">,
): ApprovalListItem {
	return {
		id: row.token,
		kind: row.kind,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		decidedAt: row.decision ? row.consumed_at : null,
		requestedBy: row.oauth_client_id ? (names.get(row.oauth_client_id) ?? null) : null,
		approveUrl: `/approve/${encodeURIComponent(row.token)}`,
		revealsSecret: Boolean(controlPlaneKind(row.kind)?.redact),
		...rest,
	};
}

/** Mirrors `getIntentStatus` for a decided row without re-reading the mailbox. */
function decidedStatus(row: Row): IntentStatusName {
	if (row.decision === "denied") return "denied";
	if (row.kind === "send") return row.send_status === "sent" ? "sent" : "approved";
	if (row.result_json) {
		try {
			const result = JSON.parse(row.result_json) as { items?: Array<{ status?: string }> };
			return result.items?.some((entry) => entry.status === "failed") ? "failed" : "executed";
		} catch {
			return "failed";
		}
	}
	return "approved";
}

async function sendSummary(
	env: Env,
	row: Row,
	withBody: boolean,
): Promise<ApprovalSendSummary | null> {
	if (row.kind !== "send" || !row.mailbox_id || !row.draft_id) return null;
	const frozen = await readFrozen(env, row.mailbox_id, row.draft_id).catch(() => null);
	if (!frozen) return null;
	const snapshot = frozen.snapshot;
	const { from } = fieldsFromSnapshot(snapshot);
	const identity = (snapshot.identity ?? {}) as Record<string, unknown>;
	const text = typeof snapshot.text === "string" ? snapshot.text : "";
	return {
		mailboxId: row.mailbox_id,
		draftId: row.draft_id,
		threadId: stringOrNull(snapshot.threadId),
		parentMessageId: stringOrNull(snapshot.parentMessageId),
		from,
		fromName: stringOrNull(identity.fromName),
		to: strings(snapshot.to),
		cc: strings(snapshot.cc),
		bcc: strings(snapshot.bcc),
		subject: typeof snapshot.subject === "string" ? snapshot.subject : "",
		text: withBody ? text : null,
		snippet: text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS),
		attachments: Array.isArray(snapshot.attachments) ? snapshot.attachments.length : 0,
	};
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Client names for the rows' OAuth client ids, in one query. Missing table or row: no name. */
async function clientNames(env: Env, rows: Row[]): Promise<Map<string, string>> {
	const ids = [
		...new Set(rows.map((row) => row.oauth_client_id).filter((id): id is string => Boolean(id))),
	];
	const names = new Map<string, string>();
	if (ids.length === 0) return names;
	try {
		const result = await env.INDEX_DB.prepare(
			`SELECT "clientId" AS id, "name" AS name FROM "oauthClient" WHERE "clientId" IN (${ids.map(() => "?").join(",")})`,
		)
			.bind(...ids)
			.all<{ id: string; name: string | null }>();
		for (const entry of result.results) {
			const name = entry.name?.trim();
			if (name) names.set(entry.id, name.slice(0, 80));
		}
	} catch {
		// Better Auth tables not migrated (tests) — the UI falls back to "the agent".
	}
	return names;
}
