#!/usr/bin/env tsx
/**
 * `pnpm replay:dlq` — re-ingests inbound mail that ended in the inbound DLQ.
 *
 * The DLQ consumer leaves a tombstone per dead message (`ops_events`,
 * event_type `dlq.dead_letter`) whose `payload_json.summary` has the mailbox id,
 * raw R2 key, sha256 and recipient domain — but not the recipient, sender or
 * headers. The raw MIME is intact in R2, so each queue message is rebuilt from it
 * (scripts/lib/replay-dlq-core.ts), validated against the production
 * `inboundEmailQueueMessageSchema`, and pushed onto the inbound queue; the normal
 * consumer then does the rest. Idempotency is the consumer's: the key is rebuilt with
 * `inboundIdempotencyKey`, so a message that did land is a duplicate, never a second row.
 *
 * Skipped, with the reason shown: R2 object missing; sha256 mismatch; `ingest_events`
 * already `processed` for the key; `message_index` already holding the raw_sha256.
 * Pushes are sequential, oldest first (threading is order-dependent). Bodies are never
 * logged; subjects are.
 *
 * receivedAt comes from the timestamp embedded in the raw R2 key (written from the
 * same instant as customMetadata.receivedAt — wrangler cannot read customMetadata).
 *
 * SAFETY: dry-run by default; `--apply` is the only thing that pushes.
 *
 * Usage:
 *   pnpm replay:dlq --env dev --since 2026-11-14T00:00:00Z [--until <iso>] [--mailbox mbx_...]
 *   pnpm replay:dlq --env dev --since ... --apply
 *
 * `--apply` needs CLOUDFLARE_API_TOKEN (Queues:Edit) and an account id
 * (CLOUDFLARE_ACCOUNT_ID or `wrangler whoami`).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundEmailQueueMessage } from "../src/cloudflare/types";
import { sha256Hex } from "../src/lib/crypto";
import {
	cfApi,
	d1Select,
	fetchRawObject,
	resolveAccountId,
	resolveQueueId,
	sleep,
	sqlString,
} from "./lib/remote-cf";
import {
	type InboundDlqSummary,
	type MailboxAddresses,
	parseInboundDlqSummary,
	rebuildInboundPayload,
	skipReason,
} from "./lib/replay-dlq-core";

type WranglerBlock = {
	r2_buckets?: Array<{ binding: string; bucket_name: string; jurisdiction?: string }>;
	queues?: { producers?: Array<{ binding: string; queue: string }> };
	d1_databases?: Array<{ binding: string; database_name: string }>;
};
type WranglerConfig = WranglerBlock & { env?: Record<string, WranglerBlock> };

type Plan = {
	createdAt: string;
	summary: InboundDlqSummary;
	subject: string | null;
	payload: InboundEmailQueueMessage | null;
	skip: string | null;
	notes: string[];
};

function parseArgs(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg?.startsWith("--")) continue;
		const [key, inline] = arg.slice(2).split("=", 2);
		if (!key) continue;
		if (inline !== undefined) {
			out[key] = inline;
			continue;
		}
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) out[key] = "true";
		else {
			out[key] = next;
			i += 1;
		}
	}
	return out;
}

function fail(message: string): never {
	console.error(`replay:dlq: ${message}`);
	process.exit(1);
}

function stripJsonc(input: string): string {
	return input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function isoOrFail(flag: string, value: string): string {
	const time = Date.parse(value);
	if (Number.isNaN(time)) fail(`--${flag} must be an ISO-8601 timestamp (got "${value}").`);
	return new Date(time).toISOString();
}

const args = parseArgs(process.argv.slice(2));
const envName = args.env ?? "dev";
const apply = args.apply === "true";
if (!args.since || args.since === "true") fail("pass --since <iso timestamp> (required).");
const since = isoOrFail("since", args.since);
const until = args.until ? isoOrFail("until", args.until) : null;
const mailboxFilter = args.mailbox?.trim() || null;
const pollMs = Number(args["timeout-ms"] ?? "30000");

const config = JSON.parse(
	stripJsonc(readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8")),
) as WranglerConfig;
const block: WranglerBlock | undefined = envName === "production" ? config : config.env?.[envName];
if (!block) fail(`wrangler.jsonc has no env "${envName}".`);
const db = block.d1_databases?.find((d) => d.binding === "INDEX_DB")?.database_name;
const r2 = block.r2_buckets?.find((b) => b.binding === "MAIL_OBJECTS");
const queueName = block.queues?.producers?.find((p) => p.binding === "INBOUND_EMAIL_QUEUE")?.queue;
if (!db || !r2?.bucket_name || !queueName) {
	fail(`env "${envName}" is missing an INDEX_DB, MAIL_OBJECTS or INBOUND_EMAIL_QUEUE binding.`);
}
const envArgs = envName === "production" ? [] : ["--env", envName];

console.log("DLQ inbound replay");
console.log(`  Env:      ${envName}`);
console.log(`  D1:       ${db}`);
console.log(
	`  R2:       ${r2.bucket_name}${r2.jurisdiction ? ` (jurisdiction ${r2.jurisdiction})` : ""}`,
);
console.log(`  Queue:    ${queueName}`);
console.log(
	`  Window:   ${since} .. ${until ?? "now"}${mailboxFilter ? `  mailbox=${mailboxFilter}` : ""}`,
);
console.log(`  Mode:     ${apply ? "APPLY" : "DRY RUN (pass --apply to push)"}`);
console.log();

const tombstones = d1Select<{ id: string; created_at: string; payload_json: string }>(
	db,
	`SELECT id, created_at, payload_json FROM ops_events
	  WHERE event_type = 'dlq.dead_letter' AND created_at >= ${sqlString(since)}
	    ${until ? `AND created_at <= ${sqlString(until)}` : ""}
	  ORDER BY created_at ASC;`,
	envArgs,
);

// One entry per dead message: a tombstone can be written twice (lost ack) and a message
// can die more than once; the raw object is the identity.
const seen = new Set<string>();
const candidates: Array<{ createdAt: string; summary: InboundDlqSummary }> = [];
let nonInbound = 0;
for (const row of tombstones) {
	const summary = parseInboundDlqSummary(row.payload_json);
	if (!summary) {
		nonInbound += 1;
		continue;
	}
	if (mailboxFilter && summary.mailboxId !== mailboxFilter) continue;
	const identity = `${summary.mailboxId}:${summary.rawSha256}`;
	if (seen.has(identity)) continue;
	seen.add(identity);
	candidates.push({ createdAt: row.created_at, summary });
}
console.log(
	`${tombstones.length} dlq.dead_letter event(s) in window; ${nonInbound} not inbound; ${candidates.length} inbound candidate(s).`,
);
console.log();

const mailboxIds = [...new Set(candidates.map((c) => c.summary.mailboxId))];
const mailboxes = new Map<string, MailboxAddresses>();
if (mailboxIds.length > 0) {
	const list = mailboxIds.map(sqlString).join(", ");
	const mailboxRows = d1Select<{ mailbox_id: string; primary_address: string }>(
		db,
		`SELECT mailbox_id, primary_address FROM mailboxes WHERE mailbox_id IN (${list});`,
		envArgs,
	);
	const aliasRows = d1Select<{ mailbox_id: string; alias_address: string }>(
		db,
		`SELECT mailbox_id, alias_address FROM aliases WHERE status = 'active' AND mailbox_id IN (${list});`,
		envArgs,
	);
	for (const row of mailboxRows) {
		mailboxes.set(row.mailbox_id, {
			mailboxId: row.mailbox_id,
			primaryAddress: row.primary_address,
			aliases: aliasRows.filter((a) => a.mailbox_id === row.mailbox_id).map((a) => a.alias_address),
		});
	}
}

const workDir = mkdtempSync(join(tmpdir(), "reccado-replay-dlq-"));
const plans: Plan[] = [];
try {
	for (const { createdAt, summary } of candidates) {
		const base = { createdAt, summary, subject: null, payload: null, notes: [] as string[] };
		const mailbox = mailboxes.get(summary.mailboxId);
		if (!mailbox) {
			plans.push({ ...base, skip: `mailbox ${summary.mailboxId} not found in D1` });
			continue;
		}
		const raw = fetchRawObject(r2.bucket_name, summary.rawR2Key, workDir, r2.jurisdiction);
		if (!raw) {
			plans.push({
				...base,
				skip: skipReason(summary, { objectFound: false, indexedBySha: false }),
			});
			continue;
		}
		const actualSha256 = await sha256Hex(raw);
		const mismatch = skipReason(summary, { objectFound: true, actualSha256, indexedBySha: false });
		if (mismatch) {
			plans.push({ ...base, skip: mismatch });
			continue;
		}
		let rebuilt: Awaited<ReturnType<typeof rebuildInboundPayload>>;
		try {
			rebuilt = await rebuildInboundPayload({ summary, metadata: {}, rawBytes: raw, mailbox });
		} catch (error) {
			plans.push({
				...base,
				skip: `cannot rebuild payload: ${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}
		const { payload, notes } = rebuilt;
		const ingest = d1Select<{ status: string }>(
			db,
			`SELECT status FROM ingest_events WHERE idempotency_key = ${sqlString(payload.idempotencyKey)};`,
			envArgs,
		)[0];
		const indexed = d1Select<{ n: number }>(
			db,
			`SELECT COUNT(*) AS n FROM message_index
			  WHERE mailbox_id = ${sqlString(summary.mailboxId)} AND raw_sha256 = ${sqlString(summary.rawSha256)};`,
			envArgs,
		)[0];
		const skip = skipReason(summary, {
			objectFound: true,
			actualSha256,
			ingestStatus: ingest?.status ?? null,
			indexedBySha: (indexed?.n ?? 0) > 0,
		});
		plans.push({ createdAt, summary, subject: payload.headers.subject, payload, skip, notes });
	}
} finally {
	rmSync(workDir, { recursive: true, force: true });
}

// Oldest message first: by receivedAt when known, else tombstone time.
plans.sort((a, b) =>
	(a.payload?.receivedAt ?? a.createdAt).localeCompare(b.payload?.receivedAt ?? b.createdAt),
);

console.log("Plan");
console.log("----");
for (const plan of plans) {
	const when = plan.payload?.receivedAt ?? plan.createdAt;
	const action = plan.skip ? `SKIP — ${plan.skip}` : "PUSH";
	console.log(
		`  ${when}  ${plan.summary.mailboxId}  ${JSON.stringify(plan.subject ?? "(none)")}  ${action}`,
	);
	for (const note of plan.notes) console.log(`      note: ${note}`);
}
if (plans.length === 0) console.log("  (nothing to replay)");
console.log();

const toPush = plans.filter((plan) => plan.payload && !plan.skip);
console.log(
	`${plans.length} candidate(s): ${toPush.length} to push, ${plans.length - toPush.length} skipped.`,
);

if (!apply) {
	console.log("DRY RUN: nothing was pushed. Re-run with --apply to push the PUSH rows above.");
	process.exit(0);
}
if (toPush.length === 0) {
	console.log("Nothing to push.");
	process.exit(0);
}

const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
if (!apiToken) fail("--apply needs CLOUDFLARE_API_TOKEN (Queues:Edit).");
const accountId = resolveAccountId();
if (!accountId) fail("could not resolve an account id; set CLOUDFLARE_ACCOUNT_ID.");
const queueId = await resolveQueueId(apiToken, accountId, queueName);
console.log(`Pushing to queue ${queueName} (${queueId}) in account ${accountId}.`);

let ingested = 0;
let notIngested = 0;
for (const plan of toPush) {
	const payload = plan.payload as InboundEmailQueueMessage;
	const label = `${payload.receivedAt} ${JSON.stringify(payload.headers.subject ?? "(none)")}`;
	try {
		await cfApi(apiToken, `/accounts/${accountId}/queues/${queueId}/messages`, {
			method: "POST",
			body: JSON.stringify({ body: payload, content_type: "json" }),
		});
	} catch (error) {
		notIngested += 1;
		console.log(`  PUSH-FAIL    ${label} — ${error instanceof Error ? error.message : error}`);
		continue;
	}
	// Sequential: wait for this one to land before the next (threading is order-dependent).
	const deadline = Date.now() + pollMs;
	let landed = false;
	while (Date.now() < deadline) {
		await sleep(2000);
		const rows = d1Select<{ n: number }>(
			db,
			`SELECT COUNT(*) AS n FROM message_index
			  WHERE mailbox_id = ${sqlString(payload.mailboxId)} AND raw_sha256 = ${sqlString(payload.rawSha256)};`,
			envArgs,
		);
		if ((rows[0]?.n ?? 0) > 0) {
			landed = true;
			break;
		}
	}
	if (landed) ingested += 1;
	else notIngested += 1;
	console.log(
		`  ${landed ? "INGESTED    " : "NOT-INGESTED"} ${label}${landed ? "" : ` — not in message_index after ${pollMs}ms`}`,
	);
}
console.log();
console.log(`${ingested} ingested, ${notIngested} not ingested.`);
if (notIngested > 0) {
	console.error("FAIL: some messages did not show up in message_index; check the DLQ/ops events.");
	process.exit(1);
}
console.log("PASS");
