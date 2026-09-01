import { generateMailboxId } from "../lib/mailbox-id";

export type DomainRow = {
	id: string;
	domain: string;
	zone_id: string;
	status: "pending" | "active" | "disabled";
	created_at: string;
	updated_at: string;
};

export type MailboxRow = {
	mailbox_id: string;
	primary_address: string;
	display_name: string | null;
	status: "active" | "disabled";
	owner_email: string | null;
	created_at: string;
	updated_at: string;
};

export type AliasRow = {
	alias_address: string;
	mailbox_id: string;
	domain_id: string;
	status: "active" | "disabled";
	created_at: string;
	updated_at: string;
};

export type RoutingRuleRow = {
	id: string;
	domain_id: string;
	pattern: string;
	priority: number;
	action: "store" | "forward" | "reject";
	mailbox_id: string | null;
	forward_to_json: string;
	reject_reason: string | null;
	enabled: number;
	created_at: string;
	updated_at: string;
};

export type AliasLookup = {
	alias_address: string;
	mailbox_id: string;
	domain_id: string;
	domain: string;
};

export type MessageIndexRow = {
	mailbox_id: string;
	message_local_id: string;
	thread_id: string;
	rfc_message_id: string | null;
	subject: string | null;
	from_addr: string;
	to_json: string;
	snippet: string | null;
	received_at: string;
	has_attachments: number;
	labels_json: string;
	state: "inbox" | "archive" | "trash" | "sent" | "draft";
	raw_r2_key: string;
	raw_sha256: string;
	updated_at: string;
};

function nowIso(): string {
	return new Date().toISOString();
}

export type OutboundSendRow = {
	id: string;
	mailbox_id: string;
	draft_id: string;
	idempotency_key: string;
	status: "pending_confirmation" | "sending" | "sent" | "failed" | "cancelled" | "unknown";
	provider_message_id: string | null;
	error_code: string | null;
	approval_mode: "human_confirmed" | "telegram_confirmed" | "preauthorized_transactional";
	created_at: string;
	updated_at: string;
};

/**
 * Shared PATCH primitive for the control-plane tables: writes only the columns present in
 * `fields` and stamps `updated_at`. The SET clause has to be assembled at runtime because
 * `COALESCE(?, col)` cannot express "write NULL here", which display_name and reject_reason both
 * need; table/column names come from the typed wrappers below and never from request data, and
 * every value is still bound. `undefined` means "leave alone", so a caller can pass an optional
 * field straight through without accidentally nulling it.
 *
 * Returns false when no row matched — that is the signal the API turns into a 404. SQLite counts
 * every row the WHERE clause matched, not only the ones whose values actually changed, so a
 * repeated no-op PATCH still reports true.
 */
async function updateRowFields(
	db: D1Database,
	table: string,
	keyColumn: string,
	keyValue: string,
	fields: Record<string, string | number | null | undefined>,
): Promise<boolean> {
	const columns = Object.keys(fields).filter((column) => fields[column] !== undefined);
	if (columns.length === 0) {
		const existing = await db
			.prepare(`SELECT 1 AS found FROM ${table} WHERE ${keyColumn} = ?`)
			.bind(keyValue)
			.first<{ found: number }>();
		return existing !== null;
	}
	const assignments = columns.map((column) => `${column} = ?`).join(", ");
	const result = await db
		.prepare(`UPDATE ${table} SET ${assignments}, updated_at = ? WHERE ${keyColumn} = ?`)
		.bind(...columns.map((column) => fields[column] ?? null), nowIso(), keyValue)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

export async function listMailboxes(db: D1Database): Promise<MailboxRow[]> {
	const result = await db
		.prepare("SELECT * FROM mailboxes ORDER BY created_at ASC")
		.all<MailboxRow>();
	return result.results ?? [];
}

export async function listMailboxesByOwner(
	db: D1Database,
	ownerEmail: string,
): Promise<MailboxRow[]> {
	const result = await db
		.prepare(
			"SELECT * FROM mailboxes WHERE owner_email = ? AND status = 'active' ORDER BY created_at ASC",
		)
		.bind(ownerEmail.trim().toLowerCase())
		.all<MailboxRow>();
	return result.results ?? [];
}

export async function getMailboxForOwner(
	db: D1Database,
	mailboxId: string,
	ownerEmail: string,
): Promise<MailboxRow | null> {
	return db
		.prepare(
			"SELECT * FROM mailboxes WHERE mailbox_id = ? AND owner_email = ? AND status = 'active'",
		)
		.bind(mailboxId, ownerEmail.trim().toLowerCase())
		.first<MailboxRow>();
}

export async function getMailbox(db: D1Database, mailboxId: string): Promise<MailboxRow | null> {
	return db
		.prepare("SELECT * FROM mailboxes WHERE mailbox_id = ?")
		.bind(mailboxId)
		.first<MailboxRow>();
}

/**
 * Creates the mailbox for `primary_address` and returns the id it actually ends up with.
 *
 * `mailbox_id` is optional: omit it and a random one is assigned here. Because ids are no longer
 * derived from the address, UNIQUE(primary_address) is the only thing keeping a re-run from
 * minting a second mailbox for the same address — hence DO NOTHING plus a read-back, which makes
 * provisioning idempotent and returns the *stored* id, not the one this call proposed.
 */
export async function insertMailbox(
	db: D1Database,
	row: Omit<MailboxRow, "mailbox_id" | "created_at" | "updated_at"> & { mailbox_id?: string },
): Promise<string> {
	const now = nowIso();
	const mailboxId = row.mailbox_id ?? generateMailboxId();
	await db
		.prepare(
			`INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(primary_address) DO NOTHING`,
		)
		.bind(
			mailboxId,
			row.primary_address,
			row.display_name,
			row.status,
			row.owner_email ? row.owner_email.trim().toLowerCase() : null,
			now,
			now,
		)
		.run();
	const stored = await db
		.prepare("SELECT mailbox_id FROM mailboxes WHERE primary_address = ?")
		.bind(row.primary_address)
		.first<{ mailbox_id: string }>();
	return stored?.mailbox_id ?? mailboxId;
}

/**
 * There is deliberately no `deleteMailbox`. The messages live in the mailbox's Durable Object and
 * in R2, and every `message_index` row carries `mailbox_id`; dropping the mailbox row would orphan
 * all of it with nothing left pointing at the data and no way back. Decommissioning is
 * `status = 'disabled'`, which already removes the mailbox from `listMailboxesByOwner` /
 * `getMailboxForOwner` and therefore from MCP.
 */
export async function updateMailbox(
	db: D1Database,
	mailboxId: string,
	fields: { display_name?: string | null; status?: MailboxRow["status"] },
): Promise<boolean> {
	return updateRowFields(db, "mailboxes", "mailbox_id", mailboxId, fields);
}

export async function listDomains(db: D1Database): Promise<DomainRow[]> {
	const result = await db.prepare("SELECT * FROM domains ORDER BY domain ASC").all<DomainRow>();
	return result.results ?? [];
}

export async function getDomainByName(db: D1Database, domain: string): Promise<DomainRow | null> {
	return db.prepare("SELECT * FROM domains WHERE domain = ?").bind(domain).first<DomainRow>();
}

export async function getDomainById(db: D1Database, id: string): Promise<DomainRow | null> {
	return db.prepare("SELECT * FROM domains WHERE id = ?").bind(id).first<DomainRow>();
}

export async function insertDomain(
	db: D1Database,
	row: Omit<DomainRow, "created_at" | "updated_at">,
): Promise<void> {
	const now = nowIso();
	await db
		.prepare(
			`INSERT INTO domains (id, domain, zone_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(row.id, row.domain, row.zone_id, row.status, now, now)
		.run();
}

/**
 * Also no `deleteDomain`: `aliases.domain_id` and `routing_rules.domain_id` are foreign keys into
 * this row. Setting `status` to anything but 'active' already stops the domain from accepting
 * mail — `resolveRoutingForRecipient` rejects it with `unknown_domain` — without breaking the
 * rows that point at it.
 */
export async function updateDomain(
	db: D1Database,
	id: string,
	fields: { status?: DomainRow["status"] },
): Promise<boolean> {
	return updateRowFields(db, "domains", "id", id, fields);
}

export async function listAliases(db: D1Database): Promise<AliasRow[]> {
	const result = await db
		.prepare("SELECT * FROM aliases ORDER BY alias_address ASC")
		.all<AliasRow>();
	return result.results ?? [];
}

export async function lookupActiveAlias(
	db: D1Database,
	aliasAddress: string,
): Promise<AliasLookup | null> {
	const canonical = aliasAddress.trim().toLowerCase();
	return db
		.prepare(
			`SELECT a.alias_address, a.mailbox_id, a.domain_id, d.domain
       FROM aliases a
       JOIN domains d ON d.id = a.domain_id
       WHERE a.alias_address = ? AND a.status = 'active' AND d.status = 'active'`,
		)
		.bind(canonical)
		.first<AliasLookup>();
}

export async function insertAlias(
	db: D1Database,
	row: Omit<AliasRow, "created_at" | "updated_at">,
): Promise<void> {
	const now = nowIso();
	await db
		.prepare(
			`INSERT INTO aliases (alias_address, mailbox_id, domain_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(row.alias_address, row.mailbox_id, row.domain_id, row.status, now, now)
		.run();
}

export async function getAlias(db: D1Database, aliasAddress: string): Promise<AliasRow | null> {
	return db
		.prepare("SELECT * FROM aliases WHERE alias_address = ?")
		.bind(aliasAddress.trim().toLowerCase())
		.first<AliasRow>();
}

/**
 * Idempotent alias insert, mirroring `insertMailbox`: DO NOTHING plus a read-back, so re-running
 * provisioning converges on the stored row instead of failing on the PRIMARY KEY. `created` is
 * false when the address was already claimed — possibly by a *different* mailbox, which callers
 * must check before treating the returned alias as their own.
 */
export async function insertAliasIfMissing(
	db: D1Database,
	row: Omit<AliasRow, "created_at" | "updated_at">,
): Promise<{ alias: AliasRow | null; created: boolean }> {
	const now = nowIso();
	const result = await db
		.prepare(
			`INSERT INTO aliases (alias_address, mailbox_id, domain_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(alias_address) DO NOTHING`,
		)
		.bind(row.alias_address, row.mailbox_id, row.domain_id, row.status, now, now)
		.run();
	return {
		alias: await getAlias(db, row.alias_address),
		created: (result.meta?.changes ?? 0) > 0,
	};
}

export async function updateAlias(
	db: D1Database,
	aliasAddress: string,
	fields: { mailbox_id?: string; domain_id?: string; status?: AliasRow["status"] },
): Promise<boolean> {
	return updateRowFields(db, "aliases", "alias_address", aliasAddress.trim().toLowerCase(), fields);
}

/**
 * Hard delete, unlike mailboxes and domains: `alias_address` is the primary key, so keeping a
 * disabled row around would leave the address permanently claimed and block re-pointing it at
 * another mailbox — which is the usual reason for removing it. Nothing references the row.
 */
export async function deleteAlias(db: D1Database, aliasAddress: string): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM aliases WHERE alias_address = ?")
		.bind(aliasAddress.trim().toLowerCase())
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

export async function listRoutingRules(
	db: D1Database,
	domainId?: string,
): Promise<RoutingRuleRow[]> {
	if (domainId) {
		const result = await db
			.prepare("SELECT * FROM routing_rules WHERE domain_id = ? ORDER BY priority ASC")
			.bind(domainId)
			.all<RoutingRuleRow>();
		return result.results ?? [];
	}
	const result = await db
		.prepare("SELECT * FROM routing_rules ORDER BY domain_id, priority ASC")
		.all<RoutingRuleRow>();
	return result.results ?? [];
}

export async function insertRoutingRule(
	db: D1Database,
	row: Omit<RoutingRuleRow, "created_at" | "updated_at">,
): Promise<void> {
	const now = nowIso();
	await db
		.prepare(
			`INSERT INTO routing_rules
       (id, domain_id, pattern, priority, action, mailbox_id, forward_to_json, reject_reason, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.domain_id,
			row.pattern,
			row.priority,
			row.action,
			row.mailbox_id,
			row.forward_to_json,
			row.reject_reason,
			row.enabled,
			now,
			now,
		)
		.run();
}

export async function getRoutingRule(db: D1Database, id: string): Promise<RoutingRuleRow | null> {
	return db.prepare("SELECT * FROM routing_rules WHERE id = ?").bind(id).first<RoutingRuleRow>();
}

export async function updateRoutingRule(
	db: D1Database,
	id: string,
	fields: {
		pattern?: string;
		priority?: number;
		action?: RoutingRuleRow["action"];
		mailbox_id?: string | null;
		forward_to_json?: string;
		reject_reason?: string | null;
		enabled?: number;
	},
): Promise<boolean> {
	return updateRowFields(db, "routing_rules", "id", id, fields);
}

/** Hard delete: a routing rule is pure configuration, with no rows or stored data depending on it. */
export async function deleteRoutingRule(db: D1Database, id: string): Promise<boolean> {
	const result = await db.prepare("DELETE FROM routing_rules WHERE id = ?").bind(id).run();
	return (result.meta?.changes ?? 0) > 0;
}

/**
 * One indexed primary-key read on the ingest path, to keep a mailbox's own status
 * authoritative over the routing rows that point at it.
 */
async function mailboxIsActive(db: D1Database, mailboxId: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT status FROM mailboxes WHERE mailbox_id = ?")
		.bind(mailboxId)
		.first<{ status: string }>();
	return row?.status === "active";
}

export async function resolveRoutingForRecipient(
	db: D1Database,
	recipient: string,
): Promise<
	| { action: "store"; mailboxId: string; ruleId: string | null; matchedAlias: string }
	| { action: "forward"; forwardTo: string[]; ruleId: string | null; matchedAlias: string }
	| { action: "reject"; reason: string; ruleId: string | null; matchedAlias: string }
> {
	const canonical = recipient.trim().toLowerCase();
	const alias = await lookupActiveAlias(db, canonical);
	if (alias) {
		// A disabled mailbox stops accepting mail outright instead of falling through
		// to the domain's catch-all. Quietly diverting someone's mail into a different
		// mailbox because theirs was disabled is a far worse surprise than a bounce —
		// and without this check `DELETE /api/mailboxes/:id` would be a lie: the row
		// says disabled while the mail keeps arriving.
		if (!(await mailboxIsActive(db, alias.mailbox_id))) {
			return {
				action: "reject",
				reason: "mailbox_disabled",
				ruleId: null,
				matchedAlias: alias.alias_address,
			};
		}
		return {
			action: "store",
			mailboxId: alias.mailbox_id,
			ruleId: null,
			matchedAlias: alias.alias_address,
		};
	}

	const domain = canonical.split("@")[1];
	if (!domain) {
		return { action: "reject", reason: "invalid_recipient", ruleId: null, matchedAlias: canonical };
	}

	const domainRow = await getDomainByName(db, domain);
	if (domainRow?.status !== "active") {
		return { action: "reject", reason: "unknown_domain", ruleId: null, matchedAlias: canonical };
	}

	const rules = await listRoutingRules(db, domainRow.id);
	const localPart = canonical.split("@")[0] ?? "";
	for (const rule of rules) {
		if (!rule.enabled) continue;
		const matches =
			rule.pattern === "*" ||
			rule.pattern === localPart ||
			rule.pattern === canonical ||
			(rule.pattern.startsWith("*@") && canonical.endsWith(rule.pattern.slice(1)));
		if (!matches) continue;

		if (rule.action === "reject") {
			return {
				action: "reject",
				reason: rule.reject_reason ?? "rejected_by_rule",
				ruleId: rule.id,
				matchedAlias: canonical,
			};
		}
		if (rule.action === "forward") {
			const forwardTo = JSON.parse(rule.forward_to_json) as string[];
			return {
				action: "forward",
				forwardTo,
				ruleId: rule.id,
				matchedAlias: canonical,
			};
		}
		if (rule.action === "store" && rule.mailbox_id) {
			if (!(await mailboxIsActive(db, rule.mailbox_id))) {
				return {
					action: "reject",
					reason: "mailbox_disabled",
					ruleId: rule.id,
					matchedAlias: canonical,
				};
			}
			return {
				action: "store",
				mailboxId: rule.mailbox_id,
				ruleId: rule.id,
				matchedAlias: canonical,
			};
		}
	}

	return { action: "reject", reason: "unmatched_recipient", ruleId: null, matchedAlias: canonical };
}

export async function upsertMessageIndex(db: D1Database, row: MessageIndexRow): Promise<void> {
	await db
		.prepare(
			`INSERT INTO message_index
       (mailbox_id, message_local_id, thread_id, rfc_message_id, subject, from_addr, to_json, snippet,
        received_at, has_attachments, labels_json, state, raw_r2_key, raw_sha256, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mailbox_id, message_local_id) DO UPDATE SET
         thread_id = excluded.thread_id,
         rfc_message_id = excluded.rfc_message_id,
         subject = excluded.subject,
         from_addr = excluded.from_addr,
         to_json = excluded.to_json,
         snippet = excluded.snippet,
         received_at = excluded.received_at,
         has_attachments = excluded.has_attachments,
         labels_json = excluded.labels_json,
         state = excluded.state,
         raw_r2_key = excluded.raw_r2_key,
         raw_sha256 = excluded.raw_sha256,
         updated_at = excluded.updated_at`,
		)
		.bind(
			row.mailbox_id,
			row.message_local_id,
			row.thread_id,
			row.rfc_message_id,
			row.subject,
			row.from_addr,
			row.to_json,
			row.snippet,
			row.received_at,
			row.has_attachments,
			row.labels_json,
			row.state,
			row.raw_r2_key,
			row.raw_sha256,
			row.updated_at,
		)
		.run();
}

export async function upsertIngestEvent(
	db: D1Database,
	row: {
		idempotency_key: string;
		mailbox_id: string;
		message_local_id: string | null;
		raw_r2_key: string;
		status: "queued" | "processed" | "failed";
		error_code?: string | null;
	},
): Promise<void> {
	const now = nowIso();
	await db
		.prepare(
			`INSERT INTO ingest_events
       (idempotency_key, mailbox_id, message_local_id, raw_r2_key, status, error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         mailbox_id = excluded.mailbox_id,
         message_local_id = excluded.message_local_id,
         raw_r2_key = excluded.raw_r2_key,
         status = excluded.status,
         error_code = excluded.error_code,
         updated_at = excluded.updated_at`,
		)
		.bind(
			row.idempotency_key,
			row.mailbox_id,
			row.message_local_id,
			row.raw_r2_key,
			row.status,
			row.error_code ?? null,
			now,
			now,
		)
		.run();
}

export async function insertOpsEvent(
	db: D1Database,
	row: {
		id: string;
		event_type: string;
		severity: "info" | "warning" | "error";
		subject: string;
		payload_json: string;
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO ops_events (id, event_type, severity, subject, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(row.id, row.event_type, row.severity, row.subject, row.payload_json, nowIso())
		.run();
}

export async function listOpsEvents(db: D1Database, limit = 50) {
	const result = await db
		.prepare("SELECT * FROM ops_events ORDER BY created_at DESC LIMIT ?")
		.bind(limit)
		.all();
	return result.results ?? [];
}

export async function listIngestFailures(db: D1Database, limit = 50) {
	const result = await db
		.prepare("SELECT * FROM ingest_events WHERE status = 'failed' ORDER BY updated_at DESC LIMIT ?")
		.bind(limit)
		.all();
	return result.results ?? [];
}

export async function deleteMessageIndexForMailbox(
	db: D1Database,
	mailboxId: string,
): Promise<void> {
	await db.prepare("DELETE FROM message_index WHERE mailbox_id = ?").bind(mailboxId).run();
}

export async function createOutboundSendIfMissing(
	db: D1Database,
	row: {
		id: string;
		mailbox_id: string;
		draft_id: string;
		idempotency_key: string;
		status: OutboundSendRow["status"];
		approval_mode?: OutboundSendRow["approval_mode"];
	},
): Promise<boolean> {
	const now = nowIso();
	const result = await db
		.prepare(
			`INSERT OR IGNORE INTO outbound_sends
       (id, mailbox_id, draft_id, idempotency_key, status, provider_message_id, error_code, approval_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.mailbox_id,
			row.draft_id,
			row.idempotency_key,
			row.status,
			row.approval_mode ?? "human_confirmed",
			now,
			now,
		)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

export async function getOutboundSendByIdempotency(
	db: D1Database,
	idempotencyKey: string,
): Promise<OutboundSendRow | null> {
	return db
		.prepare("SELECT * FROM outbound_sends WHERE idempotency_key = ?")
		.bind(idempotencyKey)
		.first<OutboundSendRow>();
}

// Outbound sends move pending_confirmation -> sending -> {sent | failed} as the
// confirm-send saga progresses (see mailbox-routes.ts). If the worker crashes or
// the DO call never returns between the "sending" write and the terminal write,
// the row is stuck at status="sending" forever. This finds those for a cron sweep
// to reconcile; see reconcileStaleOutboundSends in cloudflare/scheduled.ts.
export async function listStaleSendingOutboundSends(
	db: D1Database,
	olderThanIso: string,
	limit = 50,
): Promise<OutboundSendRow[]> {
	const result = await db
		.prepare(
			"SELECT * FROM outbound_sends WHERE status = 'sending' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?",
		)
		.bind(olderThanIso, limit)
		.all<OutboundSendRow>();
	return result.results ?? [];
}

export async function updateOutboundSendStatus(
	db: D1Database,
	input: {
		idempotencyKey: string;
		status: OutboundSendRow["status"];
		providerMessageId?: string | null;
		errorCode?: string | null;
	},
): Promise<void> {
	await db
		.prepare(
			`UPDATE outbound_sends
       SET status = ?,
           provider_message_id = COALESCE(?, provider_message_id),
           error_code = ?,
           updated_at = ?
       WHERE idempotency_key = ?`,
		)
		.bind(
			input.status,
			input.providerMessageId ?? null,
			input.errorCode ?? null,
			nowIso(),
			input.idempotencyKey,
		)
		.run();
}

export type SetupStatus = {
	domains: number;
	mailboxes: number;
	aliases: number;
	routingRules: number;
	/** True once at least one active alias resolves to an active mailbox on an active domain. */
	canReceive: boolean;
};

/** Control-plane completeness snapshot for the protected `/api/setup/status` diagnostic. */
export async function getSetupStatus(db: D1Database): Promise<SetupStatus> {
	const one = async (sql: string): Promise<number> => {
		const row = await db.prepare(sql).first<{ n: number }>();
		return row?.n ?? 0;
	};
	const [domains, mailboxes, aliases, routingRules, receivable] = await Promise.all([
		one("SELECT COUNT(*) AS n FROM domains"),
		one("SELECT COUNT(*) AS n FROM mailboxes"),
		one("SELECT COUNT(*) AS n FROM aliases"),
		one("SELECT COUNT(*) AS n FROM routing_rules"),
		one(
			`SELECT COUNT(*) AS n FROM aliases a
       JOIN mailboxes m ON m.mailbox_id = a.mailbox_id AND m.status = 'active'
       JOIN domains d ON d.id = a.domain_id AND d.status = 'active'
       WHERE a.status = 'active'`,
		),
	]);
	return { domains, mailboxes, aliases, routingRules, canReceive: receivable > 0 };
}

// --- Telegram bridge -------------------------------------------------------

export type TelegramLinkRow = {
	chat_id: string;
	message_id: number;
	mailbox_id: string;
	thread_id: string;
	message_local_id: string;
	topic_id: number | null;
	created_at: string;
};

export type TelegramActionRow = {
	token: string;
	kind: "confirm_send";
	mailbox_id: string;
	draft_id: string;
	telegram_user_id: string;
	created_at: string;
	expires_at: string;
};

export async function insertTelegramLink(
	db: D1Database,
	row: Omit<TelegramLinkRow, "created_at">,
): Promise<void> {
	await db
		.prepare(
			`INSERT OR REPLACE INTO telegram_links
       (chat_id, message_id, mailbox_id, thread_id, message_local_id, topic_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.chat_id,
			row.message_id,
			row.mailbox_id,
			row.thread_id,
			row.message_local_id,
			row.topic_id,
			nowIso(),
		)
		.run();
}

/** The thread a Telegram reply refers to, found via the message it quoted. */
export async function getTelegramLinkByMessage(
	db: D1Database,
	chatId: string,
	messageId: number,
): Promise<TelegramLinkRow | null> {
	return db
		.prepare("SELECT * FROM telegram_links WHERE chat_id = ? AND message_id = ?")
		.bind(chatId, messageId)
		.first<TelegramLinkRow>();
}

export async function insertTelegramAction(
	db: D1Database,
	row: Omit<TelegramActionRow, "created_at">,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO telegram_actions
       (token, kind, mailbox_id, draft_id, telegram_user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.token,
			row.kind,
			row.mailbox_id,
			row.draft_id,
			row.telegram_user_id,
			nowIso(),
			row.expires_at,
		)
		.run();
}

export async function getTelegramAction(
	db: D1Database,
	token: string,
): Promise<TelegramActionRow | null> {
	return db
		.prepare("SELECT * FROM telegram_actions WHERE token = ?")
		.bind(token)
		.first<TelegramActionRow>();
}

export async function deleteTelegramAction(db: D1Database, token: string): Promise<void> {
	await db.prepare("DELETE FROM telegram_actions WHERE token = ?").bind(token).run();
}

// --- Transactional API key projections (rebuildable from DO, no hash/secret) ---

export type ApiKeyProjectionRow = {
	key_id: string;
	mailbox_id: string;
	sender: string;
	display_suffix: string;
	environment: "test" | "live";
	scopes_json: string;
	template_allowlist_json: string | null;
	recipient_policy: string | null;
	quota_max: number | null;
	quota_used: number;
	expires_at: string | null;
	status: "active" | "revoked";
	created_at: string;
	updated_at: string;
	revoked_at: string | null;
};

export async function upsertApiKeyProjection(
	db: D1Database,
	row: ApiKeyProjectionRow,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO transactional_api_keys
       (key_id, mailbox_id, sender, display_suffix, environment, scopes_json,
        template_allowlist_json, recipient_policy, quota_max, quota_used, expires_at,
        status, created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key_id) DO UPDATE SET
         status = excluded.status,
         updated_at = excluded.updated_at,
         revoked_at = excluded.revoked_at`,
		)
		.bind(
			row.key_id,
			row.mailbox_id,
			row.sender,
			row.display_suffix,
			row.environment,
			row.scopes_json,
			row.template_allowlist_json,
			row.recipient_policy,
			row.quota_max,
			row.quota_used ?? 0,
			row.expires_at,
			row.status,
			row.created_at,
			row.updated_at,
			row.revoked_at,
		)
		.run();
}

export async function listApiKeyProjections(
	db: D1Database,
	mailboxId: string,
): Promise<ApiKeyProjectionRow[]> {
	const result = await db
		.prepare("SELECT * FROM transactional_api_keys WHERE mailbox_id = ? ORDER BY created_at DESC")
		.bind(mailboxId)
		.all<ApiKeyProjectionRow>();
	return result.results ?? [];
}

export async function getApiKeyProjection(
	db: D1Database,
	keyId: string,
): Promise<ApiKeyProjectionRow | null> {
	return db
		.prepare("SELECT * FROM transactional_api_keys WHERE key_id = ?")
		.bind(keyId)
		.first<ApiKeyProjectionRow>();
}

export async function deleteApiKeyProjection(db: D1Database, keyId: string): Promise<void> {
	await db.prepare("DELETE FROM transactional_api_keys WHERE key_id = ?").bind(keyId).run();
}

/** Housekeeping for the cron sweep: expired buttons are dead weight. */
export async function deleteExpiredTelegramActions(db: D1Database): Promise<number> {
	const result = await db
		.prepare("DELETE FROM telegram_actions WHERE expires_at < ?")
		.bind(nowIso())
		.run();
	return result.meta?.changes ?? 0;
}

// --- Transactional request projections (rebuildable from DO, no body/secret) ---

export type TransactionalRequestLogRow = {
	request_id: string;
	key_id: string;
	mailbox_id: string;
	status: string;
	to_addr: string;
	template_id: string | null;
	sender: string;
	provider_message_id: string | null;
	error_code: string | null;
	delivery_status: string | null;
	delivery_event_at: string | null;
	resolved_via: string | null;
	created_at: string;
	updated_at: string;
};

export async function upsertTransactionalRequestLog(
	db: D1Database,
	row: TransactionalRequestLogRow,
): Promise<void> {
	await db
		.prepare(
			`INSERT OR REPLACE INTO transactional_request_log
       (request_id, key_id, mailbox_id, status, to_addr, template_id,
        sender, provider_message_id, error_code, delivery_status, delivery_event_at,
        resolved_via, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.request_id,
			row.key_id,
			row.mailbox_id,
			row.status,
			row.to_addr,
			row.template_id,
			row.sender,
			row.provider_message_id,
			row.error_code,
			row.delivery_status ?? null,
			row.delivery_event_at ?? null,
			row.resolved_via ?? null,
			row.created_at,
			row.updated_at,
		)
		.run();
}

/**
 * Looks up a transactional request log by provider_message_id.
 * Used by the email-events queue consumer to resolve mailbox DO from delivery events.
 * Returns null if the projection is absent (event may race the write).
 */
export async function lookupTransactionalRequestByProviderMessageId(
	db: D1Database,
	providerMessageId: string,
): Promise<{ request_id: string; mailbox_id: string; to_addr: string; sender: string } | null> {
	return db
		.prepare(
			"SELECT request_id, mailbox_id, to_addr, sender FROM transactional_request_log WHERE provider_message_id = ?",
		)
		.bind(providerMessageId)
		.first<{ request_id: string; mailbox_id: string; to_addr: string; sender: string }>();
}

/**
 * Narrows the candidates a delivery event with an unrecognised provider id could
 * belong to, so the consumer knows which mailbox DO to hand it to.
 *
 * This routes; it does not decide. The DO re-runs the same narrowing against its
 * own authoritative rows and refuses if it disagrees — D1 is a rebuildable
 * projection and must never be what attributes an event to a request.
 * `LIMIT 2` is deliberate: the caller only needs to know "exactly one" from
 * "more than one".
 */
export async function lookupUnresolvedTransactionalRequestsByEnvelope(
	db: D1Database,
	filter: { sender: string; to: string; notBefore: string; notAfter: string },
): Promise<Array<{ request_id: string; mailbox_id: string }>> {
	const result = await db
		.prepare(
			`SELECT request_id, mailbox_id
       FROM transactional_request_log
       WHERE status = 'unknown'
         AND provider_message_id IS NULL
         AND created_at >= ?
         AND created_at <= ?
         AND lower(sender) = ?
         AND lower(to_addr) = ?
       LIMIT 2`,
		)
		.bind(filter.notBefore, filter.notAfter, filter.sender, filter.to)
		.all<{ request_id: string; mailbox_id: string }>();
	return result.results ?? [];
}

/**
 * Mirrors a status the DO settled from an observed delivery event. Only the DO
 * decides this; the projection follows.
 */
export async function updateTransactionalRequestResolutionProjection(
	db: D1Database,
	requestId: string,
	status: string,
	providerMessageId: string | null,
): Promise<void> {
	await db
		.prepare(
			`UPDATE transactional_request_log
       SET status = ?,
           provider_message_id = COALESCE(provider_message_id, ?),
           resolved_via = 'envelope_correlation',
           updated_at = ?
       WHERE request_id = ?`,
		)
		.bind(status, providerMessageId, new Date().toISOString(), requestId)
		.run();
}

export async function updateTransactionalRequestDeliveryProjection(
	db: D1Database,
	requestId: string,
	deliveryStatus: string,
	deliveryEventAt: string,
): Promise<void> {
	await db
		.prepare(
			"UPDATE transactional_request_log SET delivery_status = ?, delivery_event_at = ?, updated_at = ? WHERE request_id = ?",
		)
		.bind(deliveryStatus, deliveryEventAt, new Date().toISOString(), requestId)
		.run();
}

/**
 * Upserts a suppression projection to D1 (best-effort, non-authoritative mirror).
 */
export async function upsertSuppressionProjection(
	db: D1Database,
	row: {
		email: string;
		mailbox_id: string;
		reason: "hard_bounce" | "complaint" | "manual" | "provider_rejected";
		source_event_id: string | null;
		created_at: string;
		updated_at: string;
		expires_at: string | null;
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT OR REPLACE INTO recipient_suppressions
       (email, mailbox_id, reason, source_event_id, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.email.trim().toLowerCase(),
			row.mailbox_id,
			row.reason,
			row.source_event_id,
			row.created_at,
			row.updated_at,
			row.expires_at,
		)
		.run();
}

export async function listTransactionalRequestLogs(
	db: D1Database,
	keyId: string,
	limit = 50,
): Promise<TransactionalRequestLogRow[]> {
	const result = await db
		.prepare(
			"SELECT * FROM transactional_request_log WHERE key_id = ? ORDER BY created_at DESC LIMIT ?",
		)
		.bind(keyId, limit)
		.all<TransactionalRequestLogRow>();
	return result.results ?? [];
}
