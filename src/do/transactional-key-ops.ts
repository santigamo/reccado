type SqlStorage = DurableObjectState["storage"]["sql"];

import {
	displaySuffix,
	formatApiKey,
	generateKeyId,
	generateSecret,
	hashApiKey,
	type KeyEnvironment,
	type KeyScope,
	type KeyStatus,
	normalizeSenderName,
	nowISO,
	SEND_SCOPE_REQUIRES_TEMPLATES_USE,
	sendScopeHasTemplateUse,
	type TransactionalApiKeyProjection,
	type TransactionalApiKeyRecord,
	validateScopes,
} from "../lib/transactional-keys";

export type RevokeApiKeyResult = {
	key: TransactionalApiKeyRecord;
	auditEvent: { id: string };
	/** Snapshot of the revoked key projected fields (no hash/secret) for D1 projection. */
	projection: TransactionalApiKeyProjection;
};

export type CreateApiKeyInput = {
	environment: KeyEnvironment;
	sender: string;
	senderName?: string | null;
	scopes: KeyScope[];
	templateAllowlist?: string[] | null;
	recipientPolicy?: string | null;
	quotaMax?: number | null;
	expiresAt?: string | null;
};

export type CreateApiKeyResult = {
	key: TransactionalApiKeyRecord;
	plaintextKey: string;
	auditEvent: { id: string };
	/** Snapshot of the new key projected fields (no hash/secret) for D1 projection. */
	projection: TransactionalApiKeyProjection;
};

export type RotateApiKeyResult = {
	key: TransactionalApiKeyRecord;
	plaintextKey: string;
	auditEvent: { id: string };
	/** The old key ID that was revoked. The API layer uses this to update the D1 projection. */
	previousKeyId: string;
	/** Snapshot of the old key projected fields (no hash/secret) for D1 projection. */
	previousKeyProjection: TransactionalApiKeyProjection;
};

export type ListApiKeysEntry = TransactionalApiKeyProjection;

/**
 * Converts a row from the api_keys SQL table into a TransactionalApiKeyRecord.
 */
function rowToRecord(row: Record<string, unknown>): TransactionalApiKeyRecord {
	return {
		keyId: String(row.key_id),
		hashVersion: Number(row.hash_version),
		keyHash: String(row.key_hash),
		displaySuffix: String(row.display_suffix),
		environment: String(row.environment) as KeyEnvironment,
		mailboxId: String(row.mailbox_id),
		sender: String(row.sender),
		senderName: row.sender_name ? String(row.sender_name) : null,
		scopes: JSON.parse(String(row.scopes_json)) as KeyScope[],
		templateAllowlist: row.template_allowlist_json
			? (JSON.parse(String(row.template_allowlist_json)) as string[])
			: null,
		recipientPolicy: row.recipient_policy ? String(row.recipient_policy) : null,
		quotaMax: row.quota_max != null ? Number(row.quota_max) : null,
		expiresAt: row.expires_at ? String(row.expires_at) : null,
		status: String(row.status) as KeyStatus,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		revokedAt: row.revoked_at ? String(row.revoked_at) : null,
	};
}

/**
 * Creates a new API key in the mailbox DO.
 * Returns the full record and the plaintext key (only time it's available).
 */
export async function createApiKey(
	sql: SqlStorage,
	pepper: string,
	mailboxId: string,
	input: CreateApiKeyInput,
): Promise<CreateApiKeyResult> {
	if (!validateScopes(input.scopes)) {
		throw new Error("invalid_scopes");
	}
	// Every send renders a template, so `transactional:send` without
	// `transactional:templates:use` stores a key that is refused at every send. This
	// is the one function every creation passes through, so the scope set is settled
	// here rather than trusted from the caller.
	//
	// Its sibling rule — a sending key must name at least one template — is enforced
	// one layer up in `createTransactionalApiKeySchema` instead: this primitive has to
	// stay able to reproduce rows that predate the rule, which `rotateApiKey` does by
	// copying an existing key's allowlist verbatim.
	if (!sendScopeHasTemplateUse(input.scopes)) {
		throw new Error(SEND_SCOPE_REQUIRES_TEMPLATES_USE);
	}

	const keyId = generateKeyId();
	const secret = generateSecret();
	const keyHash = await hashApiKey(pepper, keyId, secret);
	const suffix = displaySuffix(secret);
	const now = nowISO();
	const eventId = crypto.randomUUID();

	sql.exec(
		`INSERT INTO api_keys
     (key_id, hash_version, key_hash, display_suffix, environment, mailbox_id, sender,
      sender_name, scopes_json, template_allowlist_json, recipient_policy, quota_max,
      expires_at, status, created_at, updated_at, revoked_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
		keyId,
		keyHash,
		suffix,
		input.environment,
		mailboxId,
		input.sender,
		normalizeSenderName(input.senderName),
		JSON.stringify(input.scopes),
		input.templateAllowlist ? JSON.stringify(input.templateAllowlist) : null,
		input.recipientPolicy ?? null,
		input.quotaMax ?? null,
		input.expiresAt ?? null,
		now,
		now,
	);

	sql.exec(
		`INSERT INTO api_key_events (id, key_id, event_type, metadata_json, created_at)
     VALUES (?, ?, 'created', ?, ?)`,
		eventId,
		keyId,
		JSON.stringify({ environment: input.environment, sender: input.sender, scopes: input.scopes }),
		now,
	);

	const row = sql.exec("SELECT * FROM api_keys WHERE key_id = ?", keyId).toArray()[0] as Record<
		string,
		unknown
	>;
	const record = rowToRecord(row);

	const projection: TransactionalApiKeyProjection = {
		keyId: record.keyId,
		mailboxId: record.mailboxId,
		sender: record.sender,
		senderName: record.senderName,
		displaySuffix: record.displaySuffix,
		environment: record.environment,
		scopes: record.scopes,
		templateAllowlist: record.templateAllowlist,
		recipientPolicy: record.recipientPolicy,
		status: record.status,
		quotaMax: record.quotaMax,
		quotaUsed: 0,
		expiresAt: record.expiresAt,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		revokedAt: record.revokedAt,
	};

	return {
		key: record,
		plaintextKey: formatApiKey(input.environment, keyId, secret),
		auditEvent: { id: eventId },
		projection,
	};
}

/**
 * Lists all API keys for a mailbox. Never returns hashes/secrets.
 */
export function listApiKeys(sql: SqlStorage, mailboxId: string): ListApiKeysEntry[] {
	const rows = sql
		.exec("SELECT * FROM api_keys WHERE mailbox_id = ? ORDER BY created_at DESC", mailboxId)
		.toArray() as Array<Record<string, unknown>>;

	return rows.map((row) => ({
		keyId: String(row.key_id),
		mailboxId: String(row.mailbox_id),
		sender: String(row.sender),
		senderName: row.sender_name ? String(row.sender_name) : null,
		displaySuffix: String(row.display_suffix),
		environment: String(row.environment) as KeyEnvironment,
		scopes: JSON.parse(String(row.scopes_json)) as KeyScope[],
		templateAllowlist: row.template_allowlist_json
			? (JSON.parse(String(row.template_allowlist_json)) as string[])
			: null,
		recipientPolicy: row.recipient_policy ? String(row.recipient_policy) : null,
		status: String(row.status) as KeyStatus,
		quotaMax: row.quota_max != null ? Number(row.quota_max) : null,
		quotaUsed: 0,
		expiresAt: row.expires_at ? String(row.expires_at) : null,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		revokedAt: row.revoked_at ? String(row.revoked_at) : null,
	}));
}

/**
 * Gets a single API key record from the DO by keyId.
 */
export function getApiKey(sql: SqlStorage, keyId: string): TransactionalApiKeyRecord | null {
	const row = sql.exec("SELECT * FROM api_keys WHERE key_id = ?", keyId).toArray()[0] as
		| Record<string, unknown>
		| undefined;
	if (!row) return null;
	return rowToRecord(row);
}

/**
 * Revokes an API key in the DO.
 * Returns the updated record and projection, or null if the key doesn't exist.
 */
export function revokeApiKey(
	sql: SqlStorage,
	keyId: string,
	reason?: string,
): RevokeApiKeyResult | null {
	const existing = getApiKey(sql, keyId);
	if (!existing) return null;
	if (existing.status === "revoked") {
		return {
			key: existing,
			auditEvent: { id: "" },
			projection: {
				keyId: existing.keyId,
				mailboxId: existing.mailboxId,
				sender: existing.sender,
				senderName: existing.senderName,
				displaySuffix: existing.displaySuffix,
				environment: existing.environment,
				scopes: existing.scopes,
				templateAllowlist: existing.templateAllowlist,
				recipientPolicy: existing.recipientPolicy,
				status: "revoked",
				quotaMax: existing.quotaMax,
				quotaUsed: 0,
				expiresAt: existing.expiresAt,
				createdAt: existing.createdAt,
				updatedAt: existing.updatedAt,
				revokedAt: existing.revokedAt,
			},
		};
	}

	const now = nowISO();
	const eventId = crypto.randomUUID();

	sql.exec(
		"UPDATE api_keys SET status = 'revoked', updated_at = ?, revoked_at = ? WHERE key_id = ?",
		now,
		now,
		keyId,
	);

	sql.exec(
		`INSERT INTO api_key_events (id, key_id, event_type, metadata_json, created_at)
     VALUES (?, ?, 'revoked', ?, ?)`,
		eventId,
		keyId,
		JSON.stringify({ reason: reason ?? null }),
		now,
	);

	const updated = getApiKey(sql, keyId);
	if (!updated) throw new Error("revoked_key_not_found");

	const projection: TransactionalApiKeyProjection = {
		keyId: updated.keyId,
		mailboxId: updated.mailboxId,
		sender: updated.sender,
		senderName: updated.senderName,
		displaySuffix: updated.displaySuffix,
		environment: updated.environment,
		scopes: updated.scopes,
		templateAllowlist: updated.templateAllowlist,
		recipientPolicy: updated.recipientPolicy,
		status: "revoked",
		quotaMax: updated.quotaMax,
		quotaUsed: 0,
		expiresAt: updated.expiresAt,
		createdAt: updated.createdAt,
		updatedAt: now,
		revokedAt: now,
	};

	return { key: updated, auditEvent: { id: eventId }, projection };
}

/**
 * Rotates an API key: creates a new key with the same properties and revokes the old one.
 * Returns the new key info including the plaintext secret.
 *
 * The entire operation (revoke old + insert new + both audit events) runs inside a
 * transactionSync for atomicity.
 */
export async function rotateApiKey(
	sql: SqlStorage,
	pepper: string,
	mailboxId: string,
	oldKeyId: string,
	transactionSync: (fn: () => void) => void,
): Promise<RotateApiKeyResult | null> {
	const existing = getApiKey(sql, oldKeyId);
	if (!existing) return null;
	if (existing.status !== "active") {
		throw new Error("key_not_active");
	}

	const newKeyId = generateKeyId();
	const secret = generateSecret();
	const keyHash = await hashApiKey(pepper, newKeyId, secret);
	const suffix = displaySuffix(secret);
	const now = nowISO();
	const revokeEventId = crypto.randomUUID();
	const rotateEventId = crypto.randomUUID();

	transactionSync(() => {
		// Revoke old key
		sql.exec(
			"UPDATE api_keys SET status = 'revoked', updated_at = ?, revoked_at = ? WHERE key_id = ?",
			now,
			now,
			oldKeyId,
		);

		// Create new key with same properties
		sql.exec(
			`INSERT INTO api_keys
       (key_id, hash_version, key_hash, display_suffix, environment, mailbox_id, sender,
        scopes_json, template_allowlist_json, recipient_policy, quota_max, expires_at,
        status, created_at, updated_at, revoked_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
			newKeyId,
			keyHash,
			suffix,
			existing.environment,
			mailboxId,
			existing.sender,
			JSON.stringify(existing.scopes),
			existing.templateAllowlist ? JSON.stringify(existing.templateAllowlist) : null,
			existing.recipientPolicy,
			existing.quotaMax,
			existing.expiresAt,
			now,
			now,
		);

		// Audit: old key revoked
		sql.exec(
			`INSERT INTO api_key_events (id, key_id, event_type, metadata_json, created_at)
       VALUES (?, ?, 'revoked', ?, ?)`,
			revokeEventId,
			oldKeyId,
			JSON.stringify({ reason: "rotated", rotatedTo: newKeyId }),
			now,
		);

		// Audit: new key rotated
		sql.exec(
			`INSERT INTO api_key_events (id, key_id, event_type, metadata_json, created_at)
       VALUES (?, ?, 'rotated', ?, ?)`,
			rotateEventId,
			newKeyId,
			JSON.stringify({ previousKeyId: oldKeyId }),
			now,
		);
	});

	const newRow = sql
		.exec("SELECT * FROM api_keys WHERE key_id = ?", newKeyId)
		.toArray()[0] as Record<string, unknown>;

	const oldKeyProjection: TransactionalApiKeyProjection = {
		keyId: oldKeyId,
		mailboxId,
		sender: existing.sender,
		senderName: existing.senderName,
		displaySuffix: existing.displaySuffix,
		environment: existing.environment,
		scopes: existing.scopes,
		templateAllowlist: existing.templateAllowlist,
		recipientPolicy: existing.recipientPolicy,
		status: "revoked",
		quotaMax: existing.quotaMax,
		quotaUsed: 0,
		expiresAt: existing.expiresAt,
		createdAt: existing.createdAt,
		updatedAt: now,
		revokedAt: now,
	};

	return {
		key: rowToRecord(newRow),
		plaintextKey: formatApiKey(existing.environment, newKeyId, secret),
		auditEvent: { id: rotateEventId },
		previousKeyId: oldKeyId,
		previousKeyProjection: oldKeyProjection,
	};
}

/**
 * Returns the audit event log for a given key.
 */
export function listApiKeyEvents(
	sql: SqlStorage,
	keyId: string,
): Array<{ id: string; eventType: string; metadata: unknown; createdAt: string }> {
	const rows = sql
		.exec("SELECT * FROM api_key_events WHERE key_id = ? ORDER BY created_at ASC", keyId)
		.toArray() as Array<Record<string, unknown>>;

	return rows.map((row) => ({
		id: String(row.id),
		eventType: String(row.event_type),
		metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null,
		createdAt: String(row.created_at),
	}));
}

/**
 * Exports API key projections for D1 rebuild. No hash, no secret.
 */
export function exportApiKeyProjections(
	sql: SqlStorage,
	mailboxId: string,
): TransactionalApiKeyProjection[] {
	return listApiKeys(sql, mailboxId);
}

export type UpdateApiKeySenderNameResult = {
	key: TransactionalApiKeyRecord;
	auditEvent: { id: string };
	projection: TransactionalApiKeyProjection;
};

/**
 * Sets or clears a key's From display name.
 *
 * Exists so changing a brand name is not a key rotation. The alternative — reissue
 * the key to change its name — would force every integrator to coordinate a secret
 * swap for a cosmetic change, and a secret rotated for no security reason is a
 * secret people learn to rotate carelessly.
 *
 * The secret, hash and sender ADDRESS are untouched: this only ever writes the
 * display phrase. A revoked key is refused, since editing how a dead credential
 * would render is meaningless and usually means the caller has the wrong key id.
 */
export function updateApiKeySenderName(
	sql: SqlStorage,
	keyId: string,
	senderName: string | null,
): UpdateApiKeySenderNameResult | null {
	const existing = getApiKey(sql, keyId);
	if (!existing) return null;
	if (existing.status === "revoked") {
		throw new Error("key_not_active");
	}

	// Throws on a name that cannot go in a header; the caller maps it to a 400.
	const normalized = normalizeSenderName(senderName);
	const now = nowISO();
	const eventId = crypto.randomUUID();

	sql.exec(
		"UPDATE api_keys SET sender_name = ?, updated_at = ? WHERE key_id = ?",
		normalized,
		now,
		keyId,
	);

	sql.exec(
		`INSERT INTO api_key_events (id, key_id, event_type, metadata_json, created_at)
     VALUES (?, ?, 'sender_name_updated', ?, ?)`,
		eventId,
		keyId,
		// Both sides recorded: "who changed the sender name and to what" is the
		// question an audit log gets asked, and the previous value is half the answer.
		JSON.stringify({ from: existing.senderName, to: normalized }),
		now,
	);

	const updated = getApiKey(sql, keyId);
	if (!updated) {
		throw new Error("key_not_found");
	}

	return {
		key: updated,
		auditEvent: { id: eventId },
		projection: {
			keyId: updated.keyId,
			mailboxId: updated.mailboxId,
			sender: updated.sender,
			senderName: updated.senderName,
			displaySuffix: updated.displaySuffix,
			environment: updated.environment,
			scopes: updated.scopes,
			templateAllowlist: updated.templateAllowlist,
			recipientPolicy: updated.recipientPolicy,
			status: updated.status,
			quotaMax: updated.quotaMax,
			quotaUsed: 0,
			expiresAt: updated.expiresAt,
			createdAt: updated.createdAt,
			updatedAt: updated.updatedAt,
			revokedAt: updated.revokedAt,
		},
	};
}
