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

export type OutboundSendRow = {
	id: string;
	mailbox_id: string;
	draft_id: string;
	idempotency_key: string;
	status: "pending_confirmation" | "sending" | "sent" | "failed" | "cancelled";
	provider_message_id: string | null;
	error_code: string | null;
	created_at: string;
	updated_at: string;
};

function nowIso(): string {
	return new Date().toISOString();
}

export async function listMailboxes(db: D1Database): Promise<MailboxRow[]> {
	const result = await db
		.prepare("SELECT * FROM mailboxes ORDER BY created_at ASC")
		.all<MailboxRow>();
	return result.results ?? [];
}

export async function getMailbox(db: D1Database, mailboxId: string): Promise<MailboxRow | null> {
	return db
		.prepare("SELECT * FROM mailboxes WHERE mailbox_id = ?")
		.bind(mailboxId)
		.first<MailboxRow>();
}

export async function insertMailbox(
	db: D1Database,
	row: Omit<MailboxRow, "created_at" | "updated_at">,
): Promise<void> {
	const now = nowIso();
	await db
		.prepare(
			`INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(row.mailbox_id, row.primary_address, row.display_name, row.status, now, now)
		.run();
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
	},
): Promise<void> {
	const now = nowIso();
	await db
		.prepare(
			`INSERT OR IGNORE INTO outbound_sends
       (id, mailbox_id, draft_id, idempotency_key, status, provider_message_id, error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
		)
		.bind(row.id, row.mailbox_id, row.draft_id, row.idempotency_key, row.status, now, now)
		.run();
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
