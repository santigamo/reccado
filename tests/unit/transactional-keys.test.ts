import { describe, expect, it } from "vitest";
import {
	formatApiKey,
	parseApiKey,
	generateKeyId,
	generateSecret,
	displaySuffix,
	hashApiKey,
	verifyApiKey,
	KEY_SCOPES,
	KEY_ENVIRONMENTS,
	validateScopes,
	type TransactionalApiKeyRecord,
} from "#/lib/transactional-keys";

const TEST_PEPPER = "test-pepper-for-testing-only-32bytes!!";

describe("generateKeyId", () => {
	it("returns a 32-character hex string", () => {
		const id = generateKeyId();
		expect(id).toMatch(/^[0-9a-f]{32}$/);
	});

	it("produces unique values", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateKeyId()));
		expect(ids.size).toBe(100);
	});
});

describe("generateSecret", () => {
	it("returns a base32url string of reasonable length", () => {
		const secret = generateSecret();
		expect(secret.length).toBeGreaterThanOrEqual(50);
		expect(secret).toMatch(/^[0-9a-v]+$/);
	});

	it("produces unique values", () => {
		const secrets = new Set(Array.from({ length: 100 }, () => generateSecret()));
		expect(secrets.size).toBe(100);
	});
});

describe("displaySuffix", () => {
	it("returns the last 6 characters of the secret", () => {
		const secret = generateSecret();
		expect(displaySuffix(secret)).toBe(secret.slice(-6));
	});
});

describe("formatApiKey / parseApiKey", () => {
	it("round-trips a test key", () => {
		const env = "test";
		const keyId = generateKeyId();
		const secret = generateSecret();
		const full = formatApiKey(env, keyId, secret);
		expect(full).toBe(`rck_test_${keyId}_${secret}`);

		const parsed = parseApiKey(full);
		expect(parsed).not.toBeNull();
		expect(parsed!.environment).toBe("test");
		expect(parsed!.keyId).toBe(keyId);
		expect(parsed!.secret).toBe(secret);
	});

	it("round-trips a live key", () => {
		const env = "live";
		const keyId = generateKeyId();
		const secret = generateSecret();
		const full = formatApiKey(env, keyId, secret);
		expect(full).toBe(`rck_live_${keyId}_${secret}`);

		const parsed = parseApiKey(full);
		expect(parsed).not.toBeNull();
		expect(parsed!.environment).toBe("live");
	});

	it("rejects invalid formats", () => {
		expect(parseApiKey("")).toBeNull();
		expect(parseApiKey("rck_test_key_secret_extra")).toBeNull();
		expect(parseApiKey("bad_test_key_secret")).toBeNull();
		expect(parseApiKey("rck_prod_key_secret")).toBeNull();
	});
});

describe("hashApiKey / verifyApiKey", () => {
	it("produces a consistent hash for the same inputs", async () => {
		const keyId = generateKeyId();
		const secret = generateSecret();
		const hash1 = await hashApiKey(TEST_PEPPER, keyId, secret);
		const hash2 = await hashApiKey(TEST_PEPPER, keyId, secret);
		expect(hash1).toBe(hash2);
	});

	it("produces different hashes for different peppers", async () => {
		const keyId = generateKeyId();
		const secret = generateSecret();
		const hash1 = await hashApiKey("pepper-a", keyId, secret);
		const hash2 = await hashApiKey("pepper-b", keyId, secret);
		expect(hash1).not.toBe(hash2);
	});

	it("verifies a key correctly", async () => {
		const keyId = generateKeyId();
		const secret = generateSecret();
		const full = formatApiKey("test", keyId, secret);
		const hash = await hashApiKey(TEST_PEPPER, keyId, secret);

		const record: TransactionalApiKeyRecord = {
			keyId,
			hashVersion: 1,
			keyHash: hash,
			displaySuffix: displaySuffix(secret),
			environment: "test",
			mailboxId: "mbx_test",
			sender: "sender@example.com",
			scopes: ["transactional:send"],
			templateAllowlist: null,
			recipientPolicy: null,
			quotaMax: null,
			expiresAt: null,
			status: "active",
			createdAt: "2025-01-01T00:00:00Z",
			updatedAt: "2025-01-01T00:00:00Z",
			revokedAt: null,
		};

		const verified = await verifyApiKey(TEST_PEPPER, full, record);
		expect(verified).toBe(true);
	});

	it("rejects a wrong secret", async () => {
		const keyId = generateKeyId();
		const secret = generateSecret();
		const wrongFull = formatApiKey("test", keyId, "wrongsecret1234567890123456789012345");
		const hash = await hashApiKey(TEST_PEPPER, keyId, secret);

		const record: TransactionalApiKeyRecord = {
			keyId,
			hashVersion: 1,
			keyHash: hash,
			displaySuffix: displaySuffix(secret),
			environment: "test",
			mailboxId: "mbx_test",
			sender: "sender@example.com",
			scopes: ["transactional:send"],
			templateAllowlist: null,
			recipientPolicy: null,
			quotaMax: null,
			expiresAt: null,
			status: "active",
			createdAt: "2025-01-01T00:00:00Z",
			updatedAt: "2025-01-01T00:00:00Z",
			revokedAt: null,
		};

		const verified = await verifyApiKey(TEST_PEPPER, wrongFull, record);
		expect(verified).toBe(false);
	});

	it("rejects a key with mismatched keyId", async () => {
		const keyId = generateKeyId();
		const secret = generateSecret();
		const full = formatApiKey("test", "differentkeyid12345678901234567890", secret);
		const hash = await hashApiKey(TEST_PEPPER, keyId, secret);

		const record: TransactionalApiKeyRecord = {
			keyId,
			hashVersion: 1,
			keyHash: hash,
			displaySuffix: displaySuffix(secret),
			environment: "test",
			mailboxId: "mbx_test",
			sender: "sender@example.com",
			scopes: ["transactional:send"],
			templateAllowlist: null,
			recipientPolicy: null,
			quotaMax: null,
			expiresAt: null,
			status: "active",
			createdAt: "2025-01-01T00:00:00Z",
			updatedAt: "2025-01-01T00:00:00Z",
			revokedAt: null,
		};

		const verified = await verifyApiKey(TEST_PEPPER, full, record);
		expect(verified).toBe(false);
	});
});

describe("verifyApiKey — status/expiry checks", () => {
	it("rejects a revoked key", async () => {
		const keyId = generateKeyId();
		const secret = generateSecret();
		const full = formatApiKey("test", keyId, secret);
		const hash = await hashApiKey(TEST_PEPPER, keyId, secret);

		const record: TransactionalApiKeyRecord = {
			keyId,
			hashVersion: 1,
			keyHash: hash,
			displaySuffix: displaySuffix(secret),
			environment: "test",
			mailboxId: "mbx_test",
			sender: "sender@example.com",
			scopes: ["transactional:send"],
			templateAllowlist: null,
			recipientPolicy: null,
			quotaMax: null,
			expiresAt: null,
			status: "revoked",
			createdAt: "2025-01-01T00:00:00Z",
			updatedAt: "2025-01-01T00:00:00Z",
			revokedAt: "2025-06-01T00:00:00Z",
		};

		const verified = await verifyApiKey(TEST_PEPPER, full, record);
		expect(verified).toBe(false);
	});

	it("rejects an expired key", async () => {
		const keyId = generateKeyId();
		const secret = generateSecret();
		const full = formatApiKey("test", keyId, secret);
		const hash = await hashApiKey(TEST_PEPPER, keyId, secret);

		const record: TransactionalApiKeyRecord = {
			keyId,
			hashVersion: 1,
			keyHash: hash,
			displaySuffix: displaySuffix(secret),
			environment: "test",
			mailboxId: "mbx_test",
			sender: "sender@example.com",
			scopes: ["transactional:send"],
			templateAllowlist: null,
			recipientPolicy: null,
			quotaMax: null,
			expiresAt: "2020-01-01T00:00:00Z",
			status: "active",
			createdAt: "2025-01-01T00:00:00Z",
			updatedAt: "2025-01-01T00:00:00Z",
			revokedAt: null,
		};

		const verified = await verifyApiKey(TEST_PEPPER, full, record);
		expect(verified).toBe(false);
	});

	it("rejects a mismatched environment", async () => {
		const keyId = generateKeyId();
		const secret = generateSecret();
		const full = formatApiKey("live", keyId, secret);
		const hash = await hashApiKey(TEST_PEPPER, keyId, secret);

		const record: TransactionalApiKeyRecord = {
			keyId,
			hashVersion: 1,
			keyHash: hash,
			displaySuffix: displaySuffix(secret),
			environment: "test",
			mailboxId: "mbx_test",
			sender: "sender@example.com",
			scopes: ["transactional:send"],
			templateAllowlist: null,
			recipientPolicy: null,
			quotaMax: null,
			expiresAt: null,
			status: "active",
			createdAt: "2025-01-01T00:00:00Z",
			updatedAt: "2025-01-01T00:00:00Z",
			revokedAt: null,
		};

		const verified = await verifyApiKey(TEST_PEPPER, full, record);
		expect(verified).toBe(false);
	});
});

describe("validateScopes", () => {
	it("accepts valid scopes", () => {
		expect(validateScopes(["transactional:send"])).toBe(true);
		expect(validateScopes(["transactional:send", "transactional:status"])).toBe(true);
		expect(validateScopes([...KEY_SCOPES])).toBe(true);
	});

	it("rejects invalid scopes", () => {
		expect(validateScopes([])).toBe(false);
		expect(validateScopes(["transactional:send", "invalid"])).toBe(false);
		expect(validateScopes(["transactional:destroy"])).toBe(false);
	});
});

describe("KEY_ENVIRONMENTS", () => {
	it("has test and live", () => {
		expect(KEY_ENVIRONMENTS).toEqual(["test", "live"]);
	});
});

describe("KeyScope constant", () => {
	it("defines the three expected scopes", () => {
		expect(KEY_SCOPES).toContain("transactional:send");
		expect(KEY_SCOPES).toContain("transactional:status");
		expect(KEY_SCOPES).toContain("transactional:templates:use");
		expect(KEY_SCOPES.length).toBe(3);
	});
});
