/**
 * Server-rendered approval markup. React renders the same fields as text
 * nodes; this string is what tests assert, and it is the only place a field
 * value is interpolated into HTML. Every value is escaped. Nothing here reads
 * an agent-authored summary, title, or warning — callers pass the view the
 * approval service already filtered.
 */

export type ApprovalPageModel = {
	title: string;
	status: string;
	fields: Array<{ label: string; value: string }>;
	warnings: Array<{ message: string }>;
	hasPasskey: boolean;
};

const STATUS_COPY: Record<string, string> = {
	pending: "Pendiente de tu aprobación",
	approved: "Aprobada. El envío está en curso.",
	sent: "Enviado.",
	executed: "Cambio aplicado.",
	failed: "El cambio no se completó. Revisa el resultado de cada operación.",
	denied: "Rechazada. No se ha enviado nada.",
	expired: "Esta solicitud ha caducado.",
	stale: "El borrador cambió después de la solicitud. No se ha enviado nada.",
};

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
		.map((field) => `<dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd>`)
		.join("");
	const warnings = view.warnings
		.map((warning) => `<li>${escapeHtml(warning.message)}</li>`)
		.join("");
	const actions =
		view.status !== "pending"
			? ""
			: view.hasPasskey
				? `<button type="button">Aprobar con passkey</button><button type="button">Rechazar</button>`
				: `<p>Para aprobar hace falta una passkey.</p><a href="/security#passkeys">Registrar una passkey</a>`;
	return (
		`<article>` +
		`<h1>${escapeHtml(view.title)}</h1>` +
		`<p>${escapeHtml(STATUS_COPY[view.status] ?? "Esta solicitud ha caducado.")}</p>` +
		`<dl>${fields}</dl>` +
		`<ul>${warnings}</ul>` +
		actions +
		`</article>`
	);
}
