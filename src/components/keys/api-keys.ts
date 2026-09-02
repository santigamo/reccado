/**
 * Frontend contract for transactional API keys: the exact shapes the Reccado
 * admin API returns, a thin typed fetch client, and presentation helpers.
 *
 * Backend reality this mirrors (see src/api/mailbox-routes.ts + src/do/mailbox-do.ts):
 *  - GET  .../transactional/api-keys                -> { keys: Projection[] }
 *  - POST .../transactional/api-keys                -> 201 { key, plaintextKey, projection }
 *  - POST .../transactional/api-keys/:id/revoke     -> { key: { key, auditEvent, projection } }
 *  - POST .../transactional/api-keys/:id/rotate     -> { key, plaintextKey, previousKeyId,
 *                                                        previousKeyProjection }
 *
 * All requests are same-origin; the browser attaches the Cloudflare Access
 * session cookie and the Origin header (required by the API's CSRF guard)
 * automatically, exactly like the mail client in `#/lib/mail`.
 *
 * SECURITY — `plaintextKey` is returned exactly once, by create and by rotate.
 * It is handed straight back to the caller and is never persisted, logged, or
 * placed in a URL by this module. The `key` object the DO returns for those two
 * operations is the full record and carries `keyHash`; `normalizeApiKey` copies
 * an explicit allowlist of fields, so no hash ever reaches the UI layer.
 */

export const KEY_ENVIRONMENTS = ["test", "live"] as const;
export type KeyEnvironment = (typeof KEY_ENVIRONMENTS)[number];

export const KEY_SCOPES = [
	"transactional:send",
	"transactional:status",
	"transactional:templates:use",
] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/**
 * The two shapes of key the server refuses to mint, mirrored here so the form can
 * say so before spending a round trip. `createTransactionalApiKeySchema` stays the
 * authority; these names match the codes it reports back.
 *
 * Both exist because a key that can send is only usable if it can also render a
 * template and names at least one: the send path treats a missing
 * `transactional:templates:use` and an empty allowlist alike as "send nothing".
 */
export const SEND_SCOPE_REQUIRES_TEMPLATES_USE = "send_scope_requires_templates_use";
export const SEND_SCOPE_REQUIRES_TEMPLATE_ALLOWLIST = "send_scope_requires_template_allowlist";

export function sendScopeHasTemplateUse(scopes: readonly KeyScope[]): boolean {
	return !scopes.includes("transactional:send") || scopes.includes("transactional:templates:use");
}

export function sendScopeHasTemplateAllowlist(
	scopes: readonly KeyScope[],
	templateAllowlist: readonly string[],
): boolean {
	return !scopes.includes("transactional:send") || templateAllowlist.length > 0;
}

/** Persisted status. `expired` is derived at read time, never stored. */
export type KeyStatus = "active" | "revoked";
export type DisplayStatus = "active" | "revoked" | "expired";

/** Safe projection of a key — never contains the hash or the secret. */
export type TransactionalApiKey = {
	keyId: string;
	mailboxId: string;
	sender: string;
	/** Display phrase for the From header, e.g. "Eccos". Null = bare address. */
	senderName: string | null;
	/** Last 6 characters of the secret, safe to display. */
	displaySuffix: string;
	environment: KeyEnvironment;
	scopes: KeyScope[];
	templateAllowlist: string[] | null;
	recipientPolicy: string | null;
	status: KeyStatus;
	quotaMax: number | null;
	quotaUsed: number;
	expiresAt: string | null;
	createdAt: string;
	updatedAt: string;
	revokedAt: string | null;
};

export type CreateApiKeyInput = {
	environment: KeyEnvironment;
	sender: string;
	scopes: KeyScope[];
	templateAllowlist?: string[];
	recipientPolicy?: string;
	quotaMax?: number;
	expiresAt?: string;
};

/** A freshly minted key plus its one-and-only plaintext reveal. */
export type MintedApiKey = {
	key: TransactionalApiKey;
	plaintextKey: string;
	/** Set by rotate: the key that was revoked in the same operation. */
	previousKeyId?: string;
};

// --------------------------------------------------------------------------
// Errors — the API answers with `{ error, message?, issues? }`; the raw code is
// preserved so the UI can show exactly what the server said.
// --------------------------------------------------------------------------

export class ApiKeyError extends Error {
	/** Verbatim server error code, e.g. `forbidden`, `validation_error`. */
	readonly code: string;
	readonly status: number;
	readonly fieldErrors: Record<string, string[]>;
	readonly formErrors: string[];

	constructor(
		code: string,
		status: number,
		opts: { message?: string; fieldErrors?: Record<string, string[]>; formErrors?: string[] } = {},
	) {
		super(opts.message ?? code);
		this.name = "ApiKeyError";
		this.code = code;
		this.status = status;
		this.fieldErrors = opts.fieldErrors ?? {};
		this.formErrors = opts.formErrors ?? [];
	}
}

/** Coerces anything thrown by the client (including network failures) into an ApiKeyError. */
export function asApiKeyError(error: unknown): ApiKeyError {
	if (error instanceof ApiKeyError) return error;
	return new ApiKeyError("network_error", 0, {
		message: error instanceof Error ? error.message : "Request failed",
	});
}

/**
 * Plain-language hint for the error codes these four routes can actually
 * produce. The raw code is always shown alongside it, never replaced.
 */
export function explainKeyError(error: ApiKeyError): string | null {
	switch (error.code) {
		case "forbidden":
			return "This mailbox is not owned by your Access identity.";
		case "transactional_api_not_configured":
			return "The worker is missing the TRANSACTIONAL_API_KEY_PEPPER secret, so keys cannot be minted or rotated.";
		case "key_not_found":
			return "That key no longer exists. Refresh the list.";
		case "invalid_sender_name":
			return "A sender name cannot contain line breaks, angle brackets or double quotes — it goes straight into the From header.";
		case "key_not_active":
			return "Only an active key can be rotated. This one is already revoked.";
		case "invalid_scopes":
			return "At least one scope is required, and every scope must be a known value.";
		case SEND_SCOPE_REQUIRES_TEMPLATES_USE:
			return "A sending key must also carry transactional:templates:use — every send renders a template.";
		case SEND_SCOPE_REQUIRES_TEMPLATE_ALLOWLIST:
			return "A sending key must list at least one allowlisted template id.";
		case "validation_error":
			return "The server rejected the form values.";
		case "origin_mismatch":
			return "Request blocked by the CSRF origin guard.";
		case "unauthorized":
			return "Your Cloudflare Access session expired. Reload the page to sign in again.";
		case "network_error":
			return "The request never reached the worker. Check your connection and retry.";
		default:
			return null;
	}
}

/** One-line rendering of an error: the server's code, its status, and the hint. */
export function describeApiKeyError(error: ApiKeyError): string {
	const status = error.status ? ` (HTTP ${error.status})` : "";
	const explanation = explainKeyError(error);
	return `${error.code}${status}${explanation ? ` — ${explanation}` : ""}`;
}

async function readError(res: Response): Promise<ApiKeyError> {
	let code = `http_${res.status}`;
	let message: string | undefined;
	let fieldErrors: Record<string, string[]> | undefined;
	let formErrors: string[] | undefined;
	try {
		const body = (await res.json()) as {
			error?: unknown;
			message?: unknown;
			issues?: { fieldErrors?: unknown; formErrors?: unknown };
		};
		if (typeof body.error === "string" && body.error.length > 0) code = body.error;
		if (typeof body.message === "string") message = body.message;
		const issues = body.issues;
		if (issues && typeof issues === "object") {
			if (issues.fieldErrors && typeof issues.fieldErrors === "object") {
				fieldErrors = issues.fieldErrors as Record<string, string[]>;
			}
			if (Array.isArray(issues.formErrors)) {
				formErrors = issues.formErrors.filter((x): x is string => typeof x === "string");
			}
		}
	} catch {
		// Non-JSON body (HTML error page, empty response): the status code stands.
	}
	return new ApiKeyError(code, res.status, { message, fieldErrors, formErrors });
}

// --------------------------------------------------------------------------
// Normalization — an explicit field allowlist, so the `keyHash` present on the
// DO's create/rotate record can never leak into component state.
// --------------------------------------------------------------------------

type RawApiKey = Record<string, unknown>;

function isKeyScope(value: unknown): value is KeyScope {
	return typeof value === "string" && (KEY_SCOPES as readonly string[]).includes(value);
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeApiKey(raw: RawApiKey): TransactionalApiKey {
	return {
		keyId: asString(raw.keyId),
		mailboxId: asString(raw.mailboxId),
		sender: asString(raw.sender),
		senderName: asStringOrNull(raw.senderName),
		displaySuffix: asString(raw.displaySuffix),
		environment: raw.environment === "live" ? "live" : "test",
		scopes: Array.isArray(raw.scopes) ? raw.scopes.filter(isKeyScope) : [],
		templateAllowlist: Array.isArray(raw.templateAllowlist)
			? raw.templateAllowlist.filter((x): x is string => typeof x === "string")
			: null,
		recipientPolicy: asStringOrNull(raw.recipientPolicy),
		status: raw.status === "revoked" ? "revoked" : "active",
		quotaMax: asNumberOrNull(raw.quotaMax),
		quotaUsed: asNumberOrNull(raw.quotaUsed) ?? 0,
		expiresAt: asStringOrNull(raw.expiresAt),
		createdAt: asString(raw.createdAt),
		updatedAt: asString(raw.updatedAt),
		revokedAt: asStringOrNull(raw.revokedAt),
	};
}

// --------------------------------------------------------------------------
// Fetch client
// --------------------------------------------------------------------------

const base = (mailboxId: string) =>
	`/api/mailboxes/${encodeURIComponent(mailboxId)}/transactional/api-keys`;

async function json<T>(res: Response): Promise<T> {
	if (!res.ok) throw await readError(res);
	return (await res.json()) as T;
}

export async function fetchApiKeys(mailboxId: string): Promise<TransactionalApiKey[]> {
	const data = await json<{ keys?: RawApiKey[] }>(await fetch(base(mailboxId)));
	return (data.keys ?? []).map(normalizeApiKey);
}

export async function createApiKey(
	mailboxId: string,
	input: CreateApiKeyInput,
): Promise<MintedApiKey> {
	const data = await json<{ key?: RawApiKey; plaintextKey?: string; projection?: RawApiKey }>(
		await fetch(base(mailboxId), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		}),
	);
	// Prefer the projection (already hash-free); fall back to the record.
	return {
		key: normalizeApiKey(data.projection ?? data.key ?? {}),
		plaintextKey: asString(data.plaintextKey),
	};
}

/**
 * Change (or clear) a key's From display name.
 *
 * A PATCH, not a reissue: the secret, its hash and the sender address are
 * untouched, so nobody has to redeploy a credential to fix how their mail reads.
 */
export async function updateApiKeySenderName(
	mailboxId: string,
	keyId: string,
	senderName: string | null,
): Promise<TransactionalApiKey | null> {
	const data = await json<{ key?: { projection?: RawApiKey; key?: RawApiKey } }>(
		await fetch(`${base(mailboxId)}/${encodeURIComponent(keyId)}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ senderName }),
		}),
	);
	const projection = data.key?.projection ?? data.key?.key;
	return projection ? normalizeApiKey(projection) : null;
}

export async function revokeApiKey(
	mailboxId: string,
	keyId: string,
): Promise<TransactionalApiKey | null> {
	// The DO wraps its RevokeApiKeyResult one level deep: `{ key: { key, projection } }`.
	const data = await json<{ key?: { key?: RawApiKey; projection?: RawApiKey } }>(
		await fetch(`${base(mailboxId)}/${encodeURIComponent(keyId)}/revoke`, { method: "POST" }),
	);
	const projection = data.key?.projection ?? data.key?.key;
	return projection ? normalizeApiKey(projection) : null;
}

export async function rotateApiKey(mailboxId: string, keyId: string): Promise<MintedApiKey> {
	const data = await json<{
		key?: RawApiKey;
		plaintextKey?: string;
		previousKeyId?: string;
	}>(await fetch(`${base(mailboxId)}/${encodeURIComponent(keyId)}/rotate`, { method: "POST" }));
	return {
		key: normalizeApiKey(data.key ?? {}),
		plaintextKey: asString(data.plaintextKey),
		previousKeyId: typeof data.previousKeyId === "string" ? data.previousKeyId : keyId,
	};
}

// --------------------------------------------------------------------------
// Presentation helpers
// --------------------------------------------------------------------------

export const SCOPE_LABELS: Record<KeyScope, { label: string; hint: string }> = {
	"transactional:send": { label: "send", hint: "Send transactional mail as the bound sender." },
	"transactional:status": { label: "status", hint: "Read the delivery status of its own sends." },
	"transactional:templates:use": { label: "templates", hint: "Render allowlisted templates." },
};

/** `revoked` wins; otherwise an `expiresAt` in the past reads as `expired`. */
export function displayStatus(key: TransactionalApiKey, now: number = Date.now()): DisplayStatus {
	if (key.status === "revoked") return "revoked";
	if (key.expiresAt) {
		const at = Date.parse(key.expiresAt);
		if (Number.isFinite(at) && at <= now) return "expired";
	}
	return "active";
}

/** `rck_live_…a1b2c3` — the shape of the key without any secret material. */
export function maskedKey(key: TransactionalApiKey): string {
	return `rck_${key.environment}_…${key.displaySuffix}`;
}

export function formatKeyDate(iso: string | null): string {
	if (!iso) return "—";
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso;
	return at.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
