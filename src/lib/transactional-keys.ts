import { base32urlEncode, hmacSha256, sha256Hex } from "./crypto";

/**
 * Format: `rck_<environment>_<key-id>_<random-secret>`
 *
 * - environment: "test" or "live"
 * - key-id: 32 hex chars (derived from a UUID without dashes)
 * - random-secret: 52-char base32url encoding of 32 random bytes
 *
 * Example: `rck_test_abc123def456abc123def456abc123de_fghijklmnopqrstuv0123456789abcdef0123456789abc`
 */

export const KEY_ENVIRONMENTS = ["test", "live"] as const;
export type KeyEnvironment = (typeof KEY_ENVIRONMENTS)[number];

export const KEY_SCOPES = [
	"transactional:send",
	"transactional:status",
	"transactional:templates:use",
] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

export const KEY_STATUSES = ["active", "revoked"] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];

export const HASH_VERSION = 1;

export type TransactionalApiKeyRecord = {
	keyId: string;
	hashVersion: number;
	keyHash: string;
	displaySuffix: string;
	environment: KeyEnvironment;
	mailboxId: string;
	sender: string;
	/**
	 * Display phrase for the From header, e.g. "Eccos" in `Eccos <hello@…>`.
	 *
	 * Per key rather than per mailbox on purpose: one mailbox can serve two
	 * products over the same reply-capable address, and each wants its own name.
	 * Null means send the bare address, which is what every key created before
	 * this column existed does — so nothing changes for them.
	 */
	senderName: string | null;
	scopes: KeyScope[];
	templateAllowlist: string[] | null;
	recipientPolicy: string | null;
	quotaMax: number | null;
	expiresAt: string | null;
	status: KeyStatus;
	createdAt: string;
	updatedAt: string;
	revokedAt: string | null;
};

export type TransactionalApiKeyProjection = {
	keyId: string;
	mailboxId: string;
	sender: string;
	senderName: string | null;
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

/**
 * Generates a 32-byte random secret and returns it as a base32url string.
 * Roughly 52 characters, 256 bits of entropy.
 */
/** Longest display phrase accepted. Well under any practical header limit. */
export const MAX_SENDER_NAME_LENGTH = 64;

export const SENDER_NAME_INVALID = "invalid_sender_name";

/**
 * Whether a string is safe to place in a From header as a display phrase.
 *
 * This value is operator-supplied and lands in a mail header, so the check is a
 * security boundary, not tidiness. CR and LF are the header-injection vector —
 * a name containing a newline could append arbitrary headers (a second Bcc, a
 * different Reply-To) to every message the key sends. Angle brackets and double
 * quotes are refused because they are the address-form delimiters: they would
 * either be escaped into something the operator did not intend or, worse,
 * produce a header that parses as a different address entirely.
 *
 * ASCII-only, and that restriction is provisional rather than principled.
 * RFC 5322 does not allow raw UTF-8 in a header: a non-ASCII display name has to
 * be RFC 2047 encoded-word encoded (`=?UTF-8?B?...?=`). The send binding builds
 * the MIME itself, so it may well do that for us — but Cloudflare's documentation
 * says nothing about the `name` field's encoding, and miniflare's local
 * implementation renders it as raw quoted UTF-8 with no encoding at all. Encoding
 * it ourselves is no safer: if the binding also encodes, recipients see a literal
 * `=?UTF-8?B?...?=` instead of the name.
 *
 * So both choices are guesses, and they fail differently. Accepting non-ASCII
 * fails SILENTLY — it renders correctly in whichever client you happen to test
 * and as mojibake in others, on mail that has already gone out. Refusing it fails
 * LOUDLY, at the moment an operator types the name, and blocks nobody today.
 *
 * To lift this: send one message with an accented name to a real mailbox and read
 * the RAW MIME (not a decoded view — a decoder makes a correctly-encoded header
 * and a broken one look identical). If `From:` carries an encoded-word, widen the
 * regex below to allow non-ASCII and delete this paragraph.
 */
export function isValidSenderName(value: string): boolean {
	if (value.length === 0 || value.length > MAX_SENDER_NAME_LENGTH) return false;
	// Printable ASCII only, minus the three delimiters. This excludes CR, LF and
	// every other control character by construction rather than by a second test.
	return /^[\x20-\x7e]+$/.test(value) && !/[<>"]/.test(value);
}

/**
 * Storage form of a display name: trimmed, with empty treated as absent.
 *
 * Null and "" must not be two different states — a key with an empty-string name
 * would render as `<hello@…>` with a stray space rather than a bare address.
 * Throws rather than silently stripping: a name the operator typed and cannot
 * have should be refused where they can see it, not quietly altered.
 */
export function normalizeSenderName(value: string | null | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (!isValidSenderName(trimmed)) {
		throw new Error(SENDER_NAME_INVALID);
	}
	return trimmed;
}

export function generateSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return base32urlEncode(bytes);
}

/**
 * Generates a key id from a UUID (without dashes). Returns 32 hex chars.
 */
export function generateKeyId(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Builds the full API key string: `rck_<env>_<keyId>_<secret>`.
 */
export function formatApiKey(environment: KeyEnvironment, keyId: string, secret: string): string {
	return `rck_${environment}_${keyId}_${secret}`;
}

/**
 * Parses a full API key string into its components.
 * Returns null if the format is invalid.
 */
export function parseApiKey(
	fullKey: string,
): { environment: KeyEnvironment; keyId: string; secret: string } | null {
	const parts = fullKey.split("_");
	// Expected: ["rck", "test"|"live", <keyId>, <secret>]
	if (parts.length !== 4 || parts[0] !== "rck") return null;
	const envStr = parts[1];
	if (!envStr || !KEY_ENVIRONMENTS.includes(envStr as KeyEnvironment)) return null;
	const environment = envStr as KeyEnvironment;
	const keyId = parts[2];
	if (!keyId || !/^[0-9a-f]{32}$/i.test(keyId)) return null;
	const maybeSecret = parts[3];
	if (!maybeSecret || maybeSecret.length < 10) return null;
	return { environment, keyId, secret: maybeSecret };
}

/**
 * Computes the HMAC-SHA256 hash of the key material, bound to the key id.
 * The message being hashed is `keyId + ":" + secret`.
 */
export async function hashApiKey(pepper: string, keyId: string, secret: string): Promise<string> {
	const message = `${keyId}:${secret}`;
	const hmac = await hmacSha256(pepper, message);
	return sha256Hex(hmac);
}

/**
 * Verifies a candidate API key against a stored record.
 * Calls hashApiKey with the stored record's keyId and compares.
 */
export async function verifyApiKey(
	pepper: string,
	candidateKey: string,
	record: TransactionalApiKeyRecord,
): Promise<boolean> {
	// Reject revoked keys — future callers (Phase 3) cannot forget this check.
	if (record.status === "revoked") return false;
	// Reject expired keys — same reasoning.
	if (record.expiresAt && new Date(record.expiresAt) <= new Date()) return false;

	const parsed = parseApiKey(candidateKey);
	if (!parsed) return false;
	if (parsed.environment !== record.environment) return false;
	if (parsed.keyId !== record.keyId) return false;
	const computedHash = await hashApiKey(pepper, record.keyId, parsed.secret);
	// Constant-time comparison to prevent timing attacks
	return constantTimeEqual(computedHash, record.keyHash);
}

/**
 * Extracts the display suffix from a secret (last 6 characters).
 */
export function displaySuffix(secret: string): string {
	return secret.slice(-6);
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		// Still do a comparison to prevent length-based timing leaks
		let result = a.length ^ b.length;
		const minLen = Math.min(a.length, b.length);
		for (let i = 0; i < minLen; i++) {
			result |= a.charCodeAt(i) ^ b.charCodeAt(i);
		}
		return result === 0;
	}
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

/**
 * Returns the current ISO timestamp.
 */
export function nowISO(): string {
	return new Date().toISOString();
}

/**
 * Default scopes for a new API key (all available scopes).
 */
export const DEFAULT_SCOPES: KeyScope[] = [
	"transactional:send",
	"transactional:status",
	"transactional:templates:use",
];

/**
 * Validates that the given scopes array contains only known scope values.
 * Says nothing about whether the combination is *usable* — see the two
 * predicates below for that.
 */
export function validateScopes(scopes: string[]): scopes is KeyScope[] {
	return scopes.length > 0 && scopes.every((s) => (KEY_SCOPES as readonly string[]).includes(s));
}

/**
 * Names for the two ways a key can be minted already incapable of sending. Both
 * layers that can refuse a key — the creation request schema and the DO's key
 * ops — report these exact strings, so the operator reads the same words
 * whichever one turned them down.
 */
export const SEND_SCOPE_REQUIRES_TEMPLATES_USE = "send_scope_requires_templates_use";
export const SEND_SCOPE_REQUIRES_TEMPLATE_ALLOWLIST = "send_scope_requires_template_allowlist";

export const KEY_SHAPE_MESSAGES = {
	[SEND_SCOPE_REQUIRES_TEMPLATES_USE]:
		"A key with transactional:send also needs transactional:templates:use, because every send renders a template.",
	[SEND_SCOPE_REQUIRES_TEMPLATE_ALLOWLIST]:
		"A key with transactional:send needs at least one allowlisted template id. An empty allowlist permits nothing, not everything.",
} as const;

/**
 * Rendering a template is the only send path, so `transactional:send` on its own
 * mints a credential that is refused with `insufficient_scope` at the first real
 * send — long after whoever asked for it has stopped watching.
 */
export function sendScopeHasTemplateUse(scopes: readonly string[]): boolean {
	return !scopes.includes("transactional:send") || scopes.includes("transactional:templates:use");
}

/**
 * The send path reads a null or empty allowlist as "no template may be sent",
 * not as "any template may be sent". A sending key therefore has to name the
 * templates it is for, or it can never send anything.
 */
export function sendScopeHasTemplateAllowlist(
	scopes: readonly string[],
	templateAllowlist: readonly string[] | null | undefined,
): boolean {
	return !scopes.includes("transactional:send") || (templateAllowlist?.length ?? 0) > 0;
}
