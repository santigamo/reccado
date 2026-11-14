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
	fields: Array<{ label: string; value: string; format?: "text" | "pre" | "list" }>;
	warnings: Array<{ message: string }>;
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
			return `<dt>${escapeHtml(field.label)}</dt><dd>${body}</dd>`;
		})
		.join("");
	const warnings = view.warnings
		.map((warning) => `<li>${escapeHtml(warning.message)}</li>`)
		.join("");
	const actions =
		view.status !== "pending"
			? ""
			: `<button type="button">Aprobar</button><button type="button">Rechazar</button>`;
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
