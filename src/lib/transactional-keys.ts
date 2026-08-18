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
 */
export function validateScopes(scopes: string[]): scopes is KeyScope[] {
	return scopes.length > 0 && scopes.every((s) => (KEY_SCOPES as readonly string[]).includes(s));
}
