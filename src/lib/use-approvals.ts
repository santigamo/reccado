/**
 * Owner approvals as the inbox consumes them: the amber count on the Approvals
 * tab, the "N requests await your approval" note in the mailbox column, the
 * "Draft awaiting approval" pill on thread rows, the Approvals list, and the
 * approval card + action bar in the reading pane.
 *
 * Data comes from `GET /api/approvals` (owner web session only). Deciding goes
 * through the existing `POST /api/approvals/:id/approve|deny` endpoints with the
 * frozen `payloadHash` — exactly what the standalone `/approve/:id` page does.
 * Nothing here can approve without the owner clicking.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { cancelDraft, createDraft } from "./mail";
import { useAsyncResource } from "./use-mail";

export type ApprovalStatus =
	| "pending"
	| "approved"
	| "sent"
	| "denied"
	| "expired"
	| "stale"
	| "executed"
	| "failed";

export type ApprovalField = { label: string; value: string; format?: "text" | "pre" | "list" };
export type ApprovalWarning = { code: string; message: string; address?: string };

export type ApprovalSend = {
	mailboxId: string;
	draftId: string;
	threadId: string | null;
	parentMessageId: string | null;
	from: string | null;
	fromName: string | null;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	text: string | null;
	snippet: string;
	attachments: number;
};

/** One row of `GET /api/approvals`. */
export type ApprovalItem = {
	id: string;
	/** "send" for an outbound message, or a control-plane kind (`api_key_create`, …). */
	kind: string;
	status: ApprovalStatus;
	createdAt: string;
	expiresAt: string;
	decidedAt: string | null;
	/** OAuth client name ("Claude"), when the server could resolve it. */
	requestedBy: string | null;
	/** `/approve/:id` — the standalone page (one-time secrets are shown only there). */
	approveUrl: string;
	revealsSecret: boolean;
	title: string;
	fields: ApprovalField[];
	warnings: ApprovalWarning[];
	payloadHash: string | null;
	send: ApprovalSend | null;
};

/** A pending item, with the shortcuts the list/pill/count consumers use. */
export type PendingApproval = ApprovalItem & {
	/** Mailbox the request belongs to, when it is about mail. */
	mailboxId: string | null;
	/** Thread a "send" approval replies into, when there is one. */
	threadId: string | null;
};

export type PendingApprovals = {
	data: PendingApproval[];
	decided: ApprovalItem[];
	loading: boolean;
	error: string | null;
	refetch: () => void;
};

type ApprovalListResponse = { pending: ApprovalItem[]; decided: ApprovalItem[]; now: string };

/** Refresh cadence while something is waiting (requests live 10 minutes). */
const POLL_PENDING_MS = 15_000;
/** Background refresh when the queue is empty (new requests also arrive this way). */
const POLL_IDLE_MS = 60_000;

const EMPTY: ApprovalListResponse = { pending: [], decided: [], now: "" };

async function fetchApprovals(): Promise<ApprovalListResponse & { skew: number }> {
	const res = await fetch("/api/approvals", { headers: { accept: "application/json" } });
	if (!res.ok) {
		if (res.status === 401 && typeof window !== "undefined") window.location.assign("/login");
		throw new Error(`HTTP ${res.status}`);
	}
	const body = (await res.json()) as ApprovalListResponse;
	const serverNow = Date.parse(body.now);
	return { ...body, skew: Number.isFinite(serverNow) ? serverNow - Date.now() : 0 };
}

/**
 * Server clock offset from the last fetch, so countdowns and expiry use the
 * server's notion of "now" (expiry is decided there).
 */
let clockSkew = 0;
export function serverNow(): number {
	return Date.now() + clockSkew;
}

function withShortcuts(item: ApprovalItem): PendingApproval {
	return {
		...item,
		mailboxId: item.send?.mailboxId ?? null,
		threadId: item.send?.threadId ?? null,
	};
}

/**
 * Pending approvals (all kinds, not expired, oldest first) and the ones decided
 * in the last 24 h. Revalidates with the inbox sync token (new mail, actions),
 * on focus, and on an interval; expired requests drop out at their expiry
 * instant without waiting for the next fetch.
 */
export function usePendingApprovals(): PendingApprovals {
	const resource = useAsyncResource(fetchApprovals, { ...EMPTY, skew: 0 }, []);
	const { refetch } = resource;
	if (resource.data.now) clockSkew = resource.data.skew;

	const pendingCount = resource.data.pending.length;
	useEffect(() => {
		const id = window.setInterval(refetch, pendingCount > 0 ? POLL_PENDING_MS : POLL_IDLE_MS);
		const onFocus = () => {
			if (document.visibilityState === "visible") refetch();
		};
		document.addEventListener("visibilitychange", onFocus);
		window.addEventListener("focus", onFocus);
		return () => {
			window.clearInterval(id);
			document.removeEventListener("visibilitychange", onFocus);
			window.removeEventListener("focus", onFocus);
		};
	}, [refetch, pendingCount]);

	// Re-filter exactly when the next request expires.
	const [expiryTick, setExpiryTick] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `expiryTick` re-arms the timer for the following expiry.
	useEffect(() => {
		const now = serverNow();
		const next = resource.data.pending
			.map((a) => Date.parse(a.expiresAt))
			.filter((t) => Number.isFinite(t) && t > now)
			.sort((a, b) => a - b)[0];
		if (next === undefined) return;
		const id = window.setTimeout(
			() => setExpiryTick((n) => n + 1),
			Math.min(next - now + 50, 2 ** 31 - 1),
		);
		return () => window.clearTimeout(id);
	}, [resource.data.pending, expiryTick]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `expiryTick` re-runs the filter at each expiry instant.
	const data = useMemo(() => {
		const now = serverNow();
		return resource.data.pending.filter((a) => Date.parse(a.expiresAt) > now).map(withShortcuts);
	}, [resource.data.pending, expiryTick]);

	return {
		data,
		decided: resource.data.decided,
		loading: resource.loading,
		error: resource.error,
		refetch,
	};
}

/** Pending approvals that belong to one thread (reading pane, list pill). */
export function approvalsForThread(
	approvals: readonly PendingApproval[],
	mailboxId: string,
	threadId: string,
): PendingApproval[] {
	return approvals.filter((a) => a.mailboxId === mailboxId && a.threadId === threadId);
}

/** Re-renders every `intervalMs` while `active`; returns the server-aligned now. */
export function useNow(intervalMs = 1000, active = true): number {
	const [now, setNow] = useState(() => serverNow());
	useEffect(() => {
		if (!active) return;
		setNow(serverNow());
		const id = window.setInterval(() => setNow(serverNow()), intervalMs);
		return () => window.clearInterval(id);
	}, [intervalMs, active]);
	return now;
}

// --------------------------------------------------------------------------
// Deciding. Same calls, same body as src/routes/approve/$id.tsx.
// --------------------------------------------------------------------------

export type ApprovalOutcome = {
	id: string;
	/** The status after the call (server's word when it gave one). */
	status: ApprovalStatus;
	/** Error code from the server, when the call did not do what was asked. */
	error: string | null;
	/** True when the request had already been decided before this click. */
	alreadyDecided: boolean;
	mailboxId: string | null;
	threadId: string | null;
	at: number;
};

type DecisionBody = { status?: ApprovalStatus; error?: string; resolved?: boolean };

async function postDecision(
	path: string,
	body: unknown,
): Promise<{ ok: boolean; httpStatus: number; body: DecisionBody }> {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const parsed = (await res.json().catch(() => ({}))) as DecisionBody;
	return { ok: res.ok, httpStatus: res.status, body: parsed };
}

function outcomeFrom(
	approval: PendingApproval,
	result: { ok: boolean; httpStatus: number; body: DecisionBody },
	fallback: ApprovalStatus,
): ApprovalOutcome {
	const status: ApprovalStatus =
		result.body.status ?? (result.httpStatus === 410 ? "expired" : fallback);
	return {
		id: approval.id,
		status,
		error: result.body.error ?? (result.ok ? null : `http_${result.httpStatus}`),
		alreadyDecided: result.body.resolved === true,
		mailboxId: approval.mailboxId,
		threadId: approval.threadId,
		at: Date.now(),
	};
}

/** Approve with the hash the owner is looking at. Never called for secret-revealing kinds. */
export async function approveApproval(approval: PendingApproval): Promise<ApprovalOutcome> {
	if (approval.revealsSecret || !approval.payloadHash) {
		throw new Error("approve_on_request_page");
	}
	const result = await postDecision(`/api/approvals/${encodeURIComponent(approval.id)}/approve`, {
		payloadHash: approval.payloadHash,
	});
	const outcome = outcomeFrom(approval, result, "pending");
	recordOutcome(outcome);
	return outcome;
}

export async function denyApproval(approval: PendingApproval): Promise<ApprovalOutcome> {
	const result = await postDecision(`/api/approvals/${encodeURIComponent(approval.id)}/deny`, {});
	const base = outcomeFrom(approval, result, "pending");
	// The deny endpoint answers with the request's status: "denied" when this click
	// denied it, or the earlier decision (sent, executed, …) when someone got there first.
	const outcome: ApprovalOutcome = {
		...base,
		error: base.status === "denied" ? null : base.error,
		alreadyDecided: result.ok && !["denied", "expired", "pending", "stale"].includes(base.status),
	};
	recordOutcome(outcome);
	return outcome;
}

/**
 * "Edit": the request is frozen and bound to its hash, so it cannot be edited.
 * Instead the owner takes the text over: a NEW draft of their own (origin web)
 * is created with the same recipients, subject and body, then the agent's
 * request is denied and the agent's draft cancelled. Sending the copy is an
 * ordinary owner send from Compose; the agent's draft is never sent.
 */
export async function takeOverAsOwnDraft(
	approval: PendingApproval,
): Promise<{ draftId: string; mailboxId: string }> {
	const send = approval.send;
	if (!send || approval.kind !== "send") throw new Error("not_a_send");
	if (send.to.length === 0) throw new Error("no_recipients");
	const draftId = await createDraft(send.mailboxId, {
		to: send.to,
		cc: send.cc.length ? send.cc : undefined,
		bcc: send.bcc.length ? send.bcc : undefined,
		subject: send.subject || "(no subject)",
		bodyText: send.text ?? "",
		threadId: send.threadId ?? undefined,
		...(send.parentMessageId ? { parentMessageId: send.parentMessageId } : {}),
	} as Parameters<typeof createDraft>[1]);
	const denied = await denyApproval(approval);
	// Only once the request is denied: the agent's draft can no longer be approved, so
	// retire it rather than leave two copies in Drafts. If the request was decided
	// elsewhere meanwhile, the copy stays as a plain draft and the agent's is untouched.
	if (denied.status === "denied") {
		await cancelDraft(send.mailboxId, send.draftId).catch(() => undefined);
	}
	return { draftId, mailboxId: send.mailboxId };
}

// Recent outcomes, so a result stays on screen after the request leaves the
// pending list (the list refetches right after a decision).
const outcomes = new Map<string, ApprovalOutcome>();
const listeners = new Set<() => void>();
let outcomesVersion = 0;

function recordOutcome(outcome: ApprovalOutcome): void {
	outcomes.set(outcome.id, outcome);
	outcomesVersion += 1;
	for (const listener of listeners) listener();
}

export function dismissOutcome(id: string): void {
	if (outcomes.delete(id)) {
		outcomesVersion += 1;
		for (const listener of listeners) listener();
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Outcomes recorded in this tab, newest first. */
export function useApprovalOutcomes(): ApprovalOutcome[] {
	const version = useSyncExternalStore(
		subscribe,
		() => outcomesVersion,
		() => 0,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the store's change signal.
	return useMemo(() => [...outcomes.values()].sort((a, b) => b.at - a.at), [version]);
}
