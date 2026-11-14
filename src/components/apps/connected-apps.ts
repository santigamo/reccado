/**
 * Contract for the "Aplicaciones conectadas" section of /security: the shapes
 * GET /api/oauth-clients and /api/mcp-client-policies return, plus the pure
 * helpers the component renders from. The server stays the authority on every
 * rule here (policy validation, the AUTO_ELIGIBLE ceiling); this only decides
 * what to show and what to send.
 */
import { AUTO_ELIGIBLE, type AutoKind, DEFAULT_MAX_AUTO_PER_HOUR, isDelegatedToken } from "#/lib/mcp-client-policy";

export type ConnectedApp = {
	client_id: string;
	name: string | null;
	redirect_hosts: string[];
	granted_scopes: string[];
	authorized: boolean;
	created_at: string | null;
	last_token_at: string | null;
};

export type ClientPolicy = {
	clientId: string;
	mailboxIds: string[];
	autoKinds: AutoKind[];
	linkDomains: string[];
	allowVariableLinks: boolean;
	maxAutoPerHour: number;
};

export type PolicyDraft = {
	mailboxIds: string[];
	kinds: AutoKind[];
	linkDomains: string;
	allowVariableLinks: boolean;
	maxAutoPerHour: number;
};

export { AUTO_ELIGIBLE, type AutoKind, DEFAULT_MAX_AUTO_PER_HOUR };

export const KIND_LABELS: Record<AutoKind, { title: string; hint: string }> = {
	template_upsert: { title: "Crear o editar plantillas", hint: "Guarda cambios en tus plantillas de correo." },
	template_archive: { title: "Archivar plantillas", hint: "Retira una plantilla sin borrarla." },
	api_key_templates: { title: "Plantillas de una clave API", hint: "Cambia qué plantillas puede usar una clave." },
	api_key_revoke: { title: "Revocar claves API", hint: "Desactiva una clave; no puede crear ni rotar claves." },
	suppression_remove: { title: "Quitar supresiones", hint: "Vuelve a permitir envíos a una dirección suprimida." },
	restore: { title: "Restaurar plantillas", hint: "Deshace un cambio anterior en una plantilla." },
};

export const DELEGATION_DISABLED_REASON =
	"Esta app puede leer tu correo; sus cambios siempre requieren tu aprobación.";
export const DELEGATION_NEEDS_ADMIN = "Esta app no tiene permiso de administración, así que no hay nada que delegar.";

/** Only a token with `admin` and no mail-read scope can ever auto-apply (server: isDelegatedToken). */
export function canDelegate(app: Pick<ConnectedApp, "granted_scopes" | "authorized">): boolean {
	return app.authorized && isDelegatedToken(new Set(app.granted_scopes));
}

/** Why the editor is off, or null when it is available. */
export function delegationBlockedReason(app: Pick<ConnectedApp, "granted_scopes" | "authorized">): string | null {
	if (canDelegate(app)) return null;
	const scopes = new Set(app.granted_scopes);
	if (scopes.has("mail:read") || scopes.has("mail:read:sensitive")) return DELEGATION_DISABLED_REASON;
	return app.authorized ? DELEGATION_NEEDS_ADMIN : "Autoriza la app primero: todavía no tiene permisos.";
}

export function emptyDraft(): PolicyDraft {
	return { mailboxIds: [], kinds: [], linkDomains: "", allowVariableLinks: false, maxAutoPerHour: DEFAULT_MAX_AUTO_PER_HOUR };
}

export function draftFromPolicy(policy: ClientPolicy | undefined): PolicyDraft {
	if (!policy) return emptyDraft();
	return {
		mailboxIds: [...policy.mailboxIds],
		kinds: [...policy.autoKinds],
		linkDomains: policy.linkDomains.join(", "),
		allowVariableLinks: policy.allowVariableLinks,
		maxAutoPerHour: policy.maxAutoPerHour,
	};
}

export function parseDomainList(text: string): string[] {
	return [...new Set(text.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean))];
}

/** A message in plain Spanish for the first thing wrong with the draft, or null when it can be sent. */
export function validateDraft(draft: PolicyDraft): string | null {
	if (draft.mailboxIds.length === 0) return "Elige al menos un buzón.";
	if (draft.kinds.length === 0) return "Elige al menos un tipo de cambio.";
	if (!Number.isInteger(draft.maxAutoPerHour) || draft.maxAutoPerHour < 1 || draft.maxAutoPerHour > 1000)
		return "El máximo por hora debe estar entre 1 y 1000.";
	return null;
}

/** Body for PUT /api/mcp-client-policies/:clientId. */
export function policyRequestBody(draft: PolicyDraft): Record<string, unknown> {
	return {
		mailboxIds: draft.mailboxIds,
		kinds: draft.kinds,
		linkDomains: parseDomainList(draft.linkDomains),
		allowVariableLinks: draft.allowVariableLinks,
		maxAutoPerHour: draft.maxAutoPerHour,
	};
}

export function appName(app: Pick<ConnectedApp, "name" | "client_id">): string {
	return app.name?.trim() || `App ${app.client_id.slice(0, 8)}`;
}

export function formatAppDate(iso: string | null): string {
	if (!iso) return "—";
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
}

export async function readJson<T>(response: Response): Promise<T> {
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return (await response.json()) as T;
}
