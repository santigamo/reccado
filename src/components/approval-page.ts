/**
 * Server-rendered approval markup. React renders the same fields as text
 * nodes; this string is what tests assert, and it is the only place a field
 * value is interpolated into HTML. Every value is escaped. Nothing here reads
 * an agent-authored summary, title, or warning — callers pass the view the
 * approval service already filtered.
 *
 * Also the page's English copy (status cards), shared with
 * src/routes/approve/$id.tsx so the string renderer and the React page cannot
 * drift apart. Titles, field labels and warnings come from the same mapping
 * the inbox uses (src/lib/approval-copy.ts).
 */

import { fieldLabel, translateTitle, warningText } from "#/lib/approval-copy";

export type ApprovalPageModel = {
	title: string;
	status: string;
	kind?: string;
	fields: Array<{ label: string; value: string; format?: "text" | "pre" | "list" }>;
	warnings: Array<{ code?: string; message: string }>;
};

export type StatusCopy = {
	/** Short label on the card's status row. */
	label: string;
	/** Card heading. */
	title: string;
	/** One or two sentences under the heading. */
	body: string;
	tone: "muted" | "progress" | "success" | "danger" | "approval";
};

const STATUS_COPY: Record<string, StatusCopy> = {
	pending: {
		label: "Awaiting your approval",
		title: "Awaiting your approval",
		body: "Nothing happens until you approve it.",
		tone: "approval",
	},
	approved: {
		label: "Approved",
		title: "Approved. Sending now.",
		body: "The email is on its way out. Reload to see the result.",
		tone: "progress",
	},
	sent: {
		label: "Sent",
		title: "Sent",
		body: "You already approved this email. It went out exactly as you reviewed it.",
		tone: "success",
	},
	executed: {
		label: "Change applied",
		title: "Change applied",
		body: "You already approved this. If it created a secret, it was shown once and cannot be shown again.",
		tone: "success",
	},
	failed: {
		label: "Did not complete",
		title: "The change did not complete",
		body: "You approved it, but applying it failed. The reason and what to do are below, when available. Check them before asking again.",
		tone: "danger",
	},
	denied: {
		label: "Denied by you",
		title: "Denied. Nothing was sent.",
		body: "The agent sees the request as denied. This link cannot be used again.",
		tone: "muted",
	},
	expired: {
		label: "Expired",
		title: "This request has expired",
		body: "Requests last 10 minutes. Nothing was sent or changed. If you still want it, ask the agent to request it again.",
		tone: "muted",
	},
	stale: {
		label: "No longer matches",
		title: "The draft changed after the request",
		body: "What you would approve is no longer what was asked for, so nothing was sent. A new request is needed.",
		tone: "muted",
	},
};

/** Control-plane wording for the states whose send copy talks about email. */
const CONTROL_STATUS_COPY: Partial<Record<string, Partial<StatusCopy>>> = {
	approved: {
		title: "Approved. Applying now.",
		body: "The change is being applied. Reload to see the result.",
	},
	denied: { title: "Denied. Nothing was changed." },
	stale: {
		title: "The request no longer matches",
		body: "What it would change is no longer what was asked for, so nothing was changed. A new request is needed.",
	},
};

/** Copy for a status; unknown statuses read as expired, as before. */
export function statusCopy(status: string, kind?: string): StatusCopy {
	const base = STATUS_COPY[status] ?? STATUS_COPY.expired!;
	const override = kind && kind !== "send" ? CONTROL_STATUS_COPY[status] : undefined;
	return override ? { ...base, ...override } : base;
}

/**
 * Page-only titles: the pending send reads as an instruction here, and the
 * fallbacks the service uses when it cannot render a request. Every other
 * title comes from the shared English copy (src/lib/approval-copy.ts).
 */
const PAGE_TITLES: Record<string, string> = {
	"Revisar envío": "Review this email before it is sent",
	"Solicitud caducada": "Expired request",
	Solicitud: "Request",
};

/** English title for the server's (Spanish) one; an unknown title passes through. */
export function displayTitle(title: string): string {
	return PAGE_TITLES[title] ?? translateTitle(title);
}

/** English field label; unknown labels pass through. Same mapping as the inbox. */
export const displayLabel = fieldLabel;

/**
 * English warning by code, same mapping as the inbox; an unknown code (or one
 * whose detail cannot be read) shows the server's text. The server copy itself
 * stays as it is: Telegram uses it.
 */
export function displayWarning(warning: { code?: string; message: string }): string {
	return warning.code
		? warningText({ code: warning.code, message: warning.message })
		: warning.message;
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export function renderApprovalPage(view: ApprovalPageModel): string {
	const fields = view.fields
		.map((field) => {
			const value = escapeHtml(field.value);
			const body =
				field.format === "pre"
					? `<pre style="max-height:20rem;overflow:auto;white-space:pre-wrap">${value}</pre>`
					: field.format === "list"
						? `<ul>${field.value
								.split("\n")
								.map((item) => `<li>${escapeHtml(item)}</li>`)
								.join("")}</ul>`
						: value;
			return `<dt>${escapeHtml(displayLabel(field.label))}</dt><dd>${body}</dd>`;
		})
		.join("");
	const warnings = view.warnings
		.map((warning) => `<li>${escapeHtml(displayWarning(warning))}</li>`)
		.join("");
	const pending = view.status === "pending";
	const copy = statusCopy(view.status, view.kind);
	const actions = !pending
		? ""
		: `<button type="button">${view.kind === "send" ? "Approve &amp; send" : "Approve"}</button><button type="button">Deny</button>`;
	return (
		`<article>` +
		`<h1>${escapeHtml(pending ? displayTitle(view.title) : copy.title)}</h1>` +
		`<p>${escapeHtml(pending ? copy.label : copy.body)}</p>` +
		`<dl>${fields}</dl>` +
		`<ul>${warnings}</ul>` +
		actions +
		`</article>`
	);
}
