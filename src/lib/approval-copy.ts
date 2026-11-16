/**
 * English copy for approval requests: the single source for the inbox and the
 * standalone /approve page (src/components/approval-page.ts re-uses it).
 *
 * The approval service renders titles, field labels and warnings in Spanish
 * (Telegram uses that copy as is). The web shows the same fields and values;
 * only the known labels/titles/warnings are translated here — titles and
 * labels by exact match, warnings by code — and anything unknown falls
 * through as the server wrote it, so a new field is never hidden, just
 * untranslated.
 */
import type { ApprovalField, ApprovalItem, ApprovalStatus, ApprovalWarning } from "./use-approvals";

const TITLES: Record<string, string> = {
	"Revisar envío": "Send an email",
	"Actualizar buzón": "Update a mailbox",
	"Actualizar dominio": "Update a domain",
	"Añadir alias": "Add an alias",
	"Aprovisionar dominio de envío": "Provision a sending domain",
	"Archivar plantilla": "Archive a template",
	"Cambiar permisos de clave API": "Change API key permissions",
	"Cambiar plantillas permitidas de clave API": "Change an API key's allowed templates",
	"Crear buzón": "Create a mailbox",
	"Crear clave API": "Create an API key",
	"Crear plantilla": "Create a template",
	"Actualizar plantilla": "Update a template",
	"Crear regla de enrutado": "Create a routing rule",
	"Actualizar regla de enrutado": "Update a routing rule",
	"Desactivar buzón": "Disable a mailbox",
	"Desactivar dominio": "Disable a domain",
	"Eliminar alias": "Remove an alias",
	"Eliminar regla de enrutado": "Remove a routing rule",
	"Quitar supresión de destinatario": "Remove a recipient suppression",
	"Reconciliar solicitudes transaccionales atascadas": "Reconcile stuck transactional requests",
	"Registrar dominio": "Add a domain",
	"Restaurar alias": "Restore an alias",
	"Restaurar buzón": "Restore a mailbox",
	"Restaurar dominio": "Restore a domain",
	"Restaurar plantilla": "Restore a template",
	"Restaurar regla de enrutado": "Restore a routing rule",
	"Revocar clave API": "Revoke an API key",
	"Rotar clave API": "Rotate an API key",
};

/** Used when the server could not render the request (stale, or decided). */
const KIND_TITLES: Record<string, string> = {
	send: "Send an email",
	api_key_create: "Create an API key",
	api_key_rotate: "Rotate an API key",
	api_key_scopes: "Change API key permissions",
	api_key_templates: "Change an API key's allowed templates",
	api_key_revoke: "Revoke an API key",
	suppression_remove: "Remove a recipient suppression",
	domain_add: "Add a domain",
	domain_provision: "Provision a sending domain",
	domain_update: "Update a domain",
	domain_disable: "Disable a domain",
	alias_add: "Add an alias",
	alias_remove: "Remove an alias",
	routing_rule_upsert: "Create or change a routing rule",
	routing_rule_remove: "Remove a routing rule",
	mailbox_create: "Create a mailbox",
	mailbox_update: "Update a mailbox",
	mailbox_disable: "Disable a mailbox",
	template_upsert: "Create or update a template",
	template_archive: "Archive a template",
	restore: "Restore a previous state",
	transactional_reconcile: "Reconcile stuck transactional requests",
	address_route: "Route an address to this Reccado",
};

/** Server titles that carry a value, translated by pattern. */
const TITLE_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
	[/^Enrutar (\S+) a este Reccado$/, (m) => `Route ${m[1]} to this Reccado`],
];

function patternTitle(title: string): string | null {
	for (const [re, to] of TITLE_PATTERNS) {
		const m = title.match(re);
		if (m) return to(m);
	}
	return null;
}

const LABELS: Record<string, string> = {
	De: "From",
	Para: "To",
	Cc: "Cc",
	Cco: "Bcc",
	"Reply-To": "Reply-To",
	HTML: "HTML",
	"Clave API (solo se muestra una vez)": "API key",
	Asunto: "Subject",
	Mensaje: "Message",
	Adjuntos: "Attachments",
	Acción: "Action",
	Alias: "Alias",
	Añadidas: "Added",
	Buzón: "Mailbox",
	Caduca: "Expires",
	Clave: "Key",
	"Correo entrante": "Inbound mail",
	Cuota: "Quota",
	Destinatario: "Recipient",
	Dirección: "Address",
	"DMARC alineación": "DMARC alignment",
	"DMARC informes (rua)": "DMARC reports (rua)",
	"DMARC política": "DMARC policy",
	"Dominio de envío": "Sending domain",
	Dominio: "Domain",
	"Enlaces encontrados": "Links found",
	Entorno: "Environment",
	"Estado actual": "Current status",
	Estado: "Status",
	Motivo: "Reason",
	"Nombre del buzón": "Mailbox name",
	"Nombre del remitente": "Sender name",
	Nombre: "Name",
	Patrón: "Pattern",
	Permisos: "Permissions",
	Plantilla: "Template",
	"Plantillas permitidas": "Allowed templates",
	"Política de destinatarios": "Recipient policy",
	"Propietario del buzón": "Mailbox owner",
	Quitadas: "Removed",
	Remitente: "Sender",
	"Solicitudes atascadas (aprox.)": "Stuck requests (approx.)",
	"Zona Cloudflare": "Cloudflare zone",
	"Regla a crear": "Rule to create",
	Resultado: "Result",
	"Qué hacer": "What to do",
	Comando: "Command",
	Zona: "Zone",
};

/** The part of a server message a regex captures; null when it does not match. */
function grab(w: ApprovalWarning, re: RegExp): string | null {
	return w.message.match(re)?.[1]?.trim() || null;
}

/**
 * English warnings by code. A translator returns null when it cannot read the
 * detail it needs out of the server message; the server text is shown then.
 */
const WARNINGS: Record<string, (w: ApprovalWarning) => string | null> = {
	external_recipient: (w) =>
		w.address ? `${w.address} is outside your domains.` : "A recipient is outside your domains.",
	never_seen_recipient: (w) =>
		w.address
			? `You have never exchanged mail with ${w.address} in this mailbox.`
			: "You have never exchanged mail with a recipient in this mailbox.",
	reply_to_mismatch: () => "Reply-To does not match From.",
	sensitive_content: () =>
		"The message seems to contain a secret (a code, a sign-in or reset link). Check it before sending.",
	live_key: () => "Live key: it will be able to send real mail.",
	no_recipient_policy: () => "No recipient policy: it can send to anyone.",
	key_rotated: () => "The current key stops working when you approve.",
	key_revoked: () => "Integrations using this key will stop working.",
	disabled: () => "Disabling the mailbox can stop it from receiving mail.",
	alias_removed: () => "Mail to this alias will no longer be delivered.",
	primary_alias: () => "This is the mailbox's primary address: it will stop receiving mail.",
	provider_removal: () => "This also removes the provider's suppression (bounce or complaint).",
	restore: () => "The saved previous state is reapplied; later changes to this item are lost.",
	rule_removed: () => "Mail that matched this rule will be routed differently.",
	suppressed_recipient: () =>
		"This recipient bounced or complained: sending again can hurt the domain's reputation.",
	template_archived: () => "Keys that use this template will no longer be able to send it.",
	template_overwrite: () => "Keys that use this template will send the new content.",
	manual_review: () => "They are marked “unknown” for manual review. No mail is resent or retried.",
	domain_disabled: () => "Disabling the domain stops inbound mail for the whole domain.",
	domain_has_active_mailboxes: (w) => {
		const n = grab(w, /(\d+)/);
		return n
			? `The domain has ${n} active ${n === "1" ? "mailbox" : "mailboxes"} that will stop receiving mail.`
			: null;
	},
	dns_changes: (w) => {
		const m = w.message.match(/para (\S+) en la zona (\S+?)\.?$/);
		return m
			? `Creates DNS records and turns on Email Sending for ${m[1]} in the ${m[2]} zone.`
			: null;
	},
	dmarc_enforced: (w) => {
		const mode = grab(w, /modo (\S+?):/);
		return mode ? `DMARC set to ${mode}: it affects mail already in flight.` : null;
	},
	dmarc_external_rua: (w) => {
		const to = grab(w, /:\s*(\S+)$/);
		return to ? `Aggregate DMARC reports will go to an outside address: ${to}` : null;
	},
	permissive_recipient_policy: (w) => {
		const rules = grab(w, /\):\s*(.+)$/);
		return rules ? `Permissive recipient policy (a wildcard domain): ${rules}` : null;
	},
	key_replaced: () =>
		"A new key is issued with these permissions and the current one is revoked. You will need to update the integration.",
	template_missing: (w) => {
		const id = grab(w, /plantilla (.+?) no existe/);
		return id ? `Template ${id} does not exist yet.` : null;
	},
	send_without_templates: () => "A key that can send needs at least one template.",
	cloudflare_route: (w) => {
		const m = w.message.match(/\(zona (\S+?)\) que entrega (\S+) a este Worker/);
		return m
			? `Creates a Cloudflare Email Routing rule (zone ${m[1]}) that delivers ${m[2]} to this Worker. It never changes or deletes an existing rule or the catch-all: if something already handles the address, nothing changes.`
			: null;
	},
	routing_token_missing: () =>
		"This Worker has no CLOUDFLARE_API_TOKEN: approving will fail without changing anything.",
	routing_worker_unknown: () =>
		"This Worker does not know its own name (WORKER_NAME): approving will fail without changing anything.",
	external_forward: (w) => {
		const to = grab(w, /:\s*(\S+)$/);
		return to ? `Forwards to an outside address: ${to}` : null;
	},
};

export function approvalTitle(item: Pick<ApprovalItem, "title" | "kind">): string {
	return (
		TITLES[item.title] ??
		patternTitle(item.title) ??
		KIND_TITLES[item.kind] ??
		(item.title || item.kind)
	);
}

export function fieldLabel(label: string): string {
	if (label.startsWith("campo: ")) return `Field: ${label.slice(7)}`;
	return LABELS[label] ?? label;
}

export function fieldValue(field: ApprovalField): string {
	return field.value === "(vacío)" ? "—" : field.value;
}

/** English text for a warning by its code; an unknown code shows the server's text. */
export function warningText(warning: ApprovalWarning): string {
	return WARNINGS[warning.code]?.(warning) ?? warning.message;
}

/** English for a server (Spanish) request title; an unknown title passes through. */
export function translateTitle(title: string): string {
	return TITLES[title] ?? patternTitle(title) ?? title;
}

/** Who asked: the OAuth client's name when known. */
export function requester(item: Pick<ApprovalItem, "requestedBy">): string {
	return item.requestedBy ?? "The agent";
}

/** Short status line, same meanings as the standalone approve page. */
export const STATUS_COPY: Record<ApprovalStatus, { label: string; title: string; detail: string }> =
	{
		pending: {
			label: "Awaiting your approval",
			title: "Awaiting your approval",
			detail: "Nothing happens until you approve.",
		},
		approved: {
			label: "Approved",
			title: "Approved. Sending now.",
			detail: "It is on its way out. The result shows up here shortly.",
		},
		sent: {
			label: "Sent",
			title: "Sent",
			detail: "It went out exactly as you reviewed it.",
		},
		executed: {
			label: "Change applied",
			title: "Change applied",
			detail: "The change was applied exactly as you reviewed it.",
		},
		failed: {
			label: "Did not complete",
			title: "The change did not complete",
			detail:
				"You approved it, but applying it failed. Check the request page before asking again.",
		},
		denied: {
			label: "Discarded",
			title: "Discarded. Nothing was sent.",
			detail: "The agent sees the request as denied.",
		},
		expired: {
			label: "Expired",
			title: "This request has expired",
			detail:
				"Requests last 10 minutes. Nothing was sent or changed. Ask the agent to request it again.",
		},
		stale: {
			label: "No longer matches",
			title: "The request no longer matches",
			detail:
				"What you would approve is no longer what was asked for, so nothing can be approved. A new request is needed.",
		},
	};

/** Plain-language reason for an approve/deny error code. */
export function errorText(code: string | null): string | null {
	if (!code) return null;
	switch (code) {
		case "expired":
			return STATUS_COPY.expired.title;
		case "stale":
		case "intent_stale":
			return STATUS_COPY.stale.title;
		case "forbidden":
			return "You can't approve this request: it was made for another owner, or you no longer own what it changes.";
		case "origin_mismatch":
			return "The request was refused for security reasons. Reload the page and try again.";
		case "unsupported_kind":
			return "This kind of request can't be approved here. Open the request page instead.";
		default:
			return `Not done (${code}). Nothing else changed; reload to see the current state.`;
	}
}

/** "2 min", "1 h 53 min", "18 h". */
export function formatWaiting(fromIso: string, now: number): string {
	const minutes = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours >= 10 || rest === 0) return `${hours} h`;
	return `${hours} h ${rest} min`;
}

/** "6:15" until expiry; "0:00" once past. */
export function formatCountdown(toIso: string, now: number): string {
	const seconds = Math.max(0, Math.ceil((Date.parse(toIso) - now) / 1000));
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}
