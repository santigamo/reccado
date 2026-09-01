#!/usr/bin/env tsx
/**
 * `pnpm reingest:mailbox` — rebuilds a mailbox Durable Object from the raw MIME
 * that is still sitting in R2, by replaying each message through the *real*
 * inbound path instead of writing DO rows by hand.
 *
 * Why this exists: a Durable Object's id is derived from its jurisdiction, so
 * pinning mailboxes to `eu` (see src/lib/mailbox-stub.ts) does not move the old
 * object — it addresses a different, empty one. R2 still holds every inbound
 * message's raw MIME, and `message_index` in the *old* D1 still enumerates it, so
 * the mail can be put back. Everything else the old DO held (outbound bodies,
 * drafts, mailbox_meta) has no source outside it and does not come back; see
 * scripts/verify-mailbox-rebuild.ts, which names those losses instead of quietly
 * counting around them.
 *
 * ## How the replay works
 *
 * Each rebuildable row is turned back into the `InboundEmailQueueMessage` that
 * `src/cloudflare/email-handler.ts` would have produced, and pushed onto the same
 * inbound queue the Email Routing worker publishes to. From there nothing is
 * special-cased: `handleInboundQueue` heads the R2 object, calls the DO's
 * `/ingest`, and `ingestInboundEmail` re-parses the MIME, re-resolves the thread,
 * rewrites the FTS row and re-extracts attachments. No parsing, threading or
 * indexing logic is reimplemented here — the payload is validated against the
 * production `inboundEmailQueueMessageSchema` before it is sent, so a payload the
 * consumer would reject cannot leave this script.
 *
 * The queue is the only way in. The DO's `/ingest` route is not reachable over
 * HTTP (nothing proxies it), and `POST /api/debug/phase0/email` — the other
 * end-to-end path — re-derives `receivedAt` from the clock, which would restamp
 * twenty months-old messages as having arrived today and write a second copy of
 * every raw object under a new key. Replaying the queue payload keeps the
 * original `receivedAt`, `rawR2Key` and `rawSha256`.
 *
 * ## Idempotency
 *
 * Not invented here, and not a second mechanism layered on top: `ingestInboundEmail`
 * looks up `ingest_events.idempotency_key` before it does anything else and returns
 * `duplicate` without inserting. The key is rebuilt with the very same
 * `inboundIdempotencyKey()` the original delivery used, over the same mailbox id,
 * Message-ID and raw sha256, so it comes out byte-identical. Two runs therefore
 * leave one message. On top of that this script pre-checks the *target* D1's
 * `ingest_events` and skips keys already recorded as processed, so a second run is
 * also a no-op at the queue.
 *
 * ## Ordering
 *
 * Messages are pushed one at a time, oldest first, each awaited to completion.
 * Threading is order-dependent — `resolveThreadId` matches an incoming message
 * against the messages already stored — and Queues makes no ordering promise, so a
 * parallel replay could group a conversation differently than it was grouped the
 * first time. Twenty sequential round-trips is a cheap price for a deterministic
 * rebuild.
 *
 * SAFETY: dry-run by default. The dry run reads exactly what the apply run reads
 * (same remote D1, same remote R2) and prints the payload it would push, so the
 * preview is the plan. `--apply` is the only thing that writes.
 *
 * Usage:
 *   pnpm reingest:mailbox --env dev --mailbox mbx_... --source-d1 inbox-mcp-index-dev
 *   pnpm reingest:mailbox --env dev --mailbox mbx_... --source-d1 inbox-mcp-index-dev --apply
 *
 * Requires: `wrangler` auth (remote D1 + R2 reads) and, for `--apply`, a
 * CLOUDFLARE_API_TOKEN with Queues:Edit plus CLOUDFLARE_ACCOUNT_ID (or a
 * `wrangler whoami` that resolves one) — pushing to a queue has no wrangler command.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundEmailQueueMessage } from "../src/cloudflare/types";
import { inboundEmailQueueMessageSchema } from "../src/cloudflare/types";
import { randomTraceId, sha256Hex } from "../src/lib/crypto";
import { normalizeMessageId } from "../src/lib/email-metadata";
import { inboundIdempotencyKey } from "../src/lib/idempotency";
import { parseMimeBytes } from "../src/lib/mime";

/** Mirrors MAX_QUEUE_BYTES in src/cloudflare/email-handler.ts (not exported). */
const MAX_QUEUE_BYTES = 128 * 1024;

type WranglerBlock = {
	r2_buckets?: Array<{ binding: string; bucket_name: string; jurisdiction?: string }>;
	queues?: { producers?: Array<{ binding: string; queue: string }> };
	d1_databases?: Array<{ binding: string; database_name: string }>;
};

type WranglerConfig = WranglerBlock & { env?: Record<string, WranglerBlock> };

type MessageIndexRow = {
	message_local_id: string;
	rfc_message_id: string | null;
	subject: string | null;
	from_addr: string;
	received_at: string;
	labels_json: string;
	state: string;
	raw_r2_key: string;
	raw_sha256: string;
};

type IngestEventRow = {
	idempotency_key: string;
	message_local_id: string | null;
	status: string;
	error_code: string | null;
};

type Rebuildable = {
	row: MessageIndexRow;
	payload: InboundEmailQueueMessage;
	rawSize: number;
	notes: string[];
};

type Unrebuildable = {
	row: MessageIndexRow;
	reason: string;
};

type Outcome = {
	row: MessageIndexRow;
	status:
		| "inserted"
		| "duplicate"
		| "conflict"
		| "timeout"
		| "push_failed"
		| "skipped"
		| "unverified";
	detail: string;
	newLocalId: string | null;
};

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg?.startsWith("--")) continue;
		const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
		if (!rawKey) continue;
		if (inlineValue !== undefined) {
			args[rawKey] = inlineValue;
			continue;
		}
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			args[rawKey] = "true";
			continue;
		}
		args[rawKey] = next;
		i += 1;
	}
	return args;
}

function fail(message: string): never {
	console.error(`reingest:mailbox: ${message}`);
	process.exit(1);
}

function stripJsonc(input: string): string {
	return input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** SQLite string literal. The only untrusted values reaching SQL are labels_json
 * and state, both read back out of D1, but they still go through here. */
function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function wrangler(args: string[]): string {
	return execFileSync("pnpm", ["wrangler", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
	});
}

/**
 * `wrangler d1 execute --json` prefixes its JSON with a human banner on some
 * versions, so cut to the first `[` rather than parsing the whole stream — the
 * same shape doctor.ts relies on.
 */
// wrangler uploads a `--file` query to R2 before running it, and the JSON it
// returns for an uploaded query carries a *summary* ("Total queries executed",
// "Rows read", ...) in `results` instead of the rows themselves. Silently, with
// success: true. So SELECTs go through `--command`, whose response really does
// carry the rows. The queries here are small enough that the argv limit is not a
// concern, and a query large enough to hit it would be the wrong shape for this
// script anyway.
function d1Query<T>(database: string, sql: string, extraArgs: string[] = []): T[] {
	const raw = wrangler([
		"d1",
		"execute",
		database,
		"--remote",
		"--json",
		"--command",
		sql,
		...extraArgs,
	]);
	const start = raw.indexOf("[");
	if (start === -1) {
		throw new Error(`unexpected wrangler d1 output:\n${raw}`);
	}
	const parsed = JSON.parse(raw.slice(start)) as Array<{ results?: T[] }>;
	return parsed[0]?.results ?? [];
}

function d1Exec(database: string, sql: string, extraArgs: string[] = []): void {
	d1Query<unknown>(database, sql, extraArgs);
}

/**
 * Reads one raw object. Returns null only for a genuine miss — any other wrangler
 * failure is rethrown, because "R2 said no" and "your token expired" must not both
 * present as "this message is unrecoverable".
 */
function fetchRawObject(
	bucket: string,
	key: string,
	dir: string,
	jurisdiction: string | undefined,
): Uint8Array | null {
	const file = join(dir, "object.eml");
	// Every download reuses this path, so clear it first: a wrangler run that exits
	// zero without writing would otherwise hand back the *previous* message's bytes.
	// The sha256 check downstream would catch it, but only as a mystery.
	rmSync(file, { force: true });
	try {
		// A jurisdiction-restricted bucket is invisible without the flag: wrangler
		// looks in the default jurisdiction, finds no such bucket, and reports every
		// key as missing. That reads identically to "this mail is unrecoverable",
		// which is the most dangerous wrong answer this script can give.
		wrangler([
			"r2",
			"object",
			"get",
			`${bucket}/${key}`,
			"--remote",
			"--file",
			file,
			...(jurisdiction ? ["--jurisdiction", jurisdiction] : []),
		]);
	} catch (error) {
		const output = [
			error instanceof Error ? error.message : String(error),
			(error as { stdout?: Buffer | string }).stdout?.toString() ?? "",
			(error as { stderr?: Buffer | string }).stderr?.toString() ?? "",
		].join("\n");
		if (/not\s*found|404|NoSuchKey|does not exist/i.test(output)) {
			return null;
		}
		throw new Error(`r2 get failed for ${key}:\n${output}`);
	}
	return new Uint8Array(readFileSync(file));
}

async function cfApi<T>(token: string, path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	const payload = (await response.json()) as {
		success?: boolean;
		result?: T;
		errors?: Array<{ message?: string; code?: number }>;
	};
	if (!response.ok || payload.success !== true) {
		const detail = (payload.errors ?? [])
			.map((item) => `${item.message ?? "unknown error"}${item.code ? ` [${item.code}]` : ""}`)
			.join("; ");
		throw new Error(detail || `Cloudflare API request failed (${response.status})`);
	}
	return payload.result as T;
}

/** Env var first, then the account `wrangler whoami` is already authenticated as. */
function resolveAccountId(): string | undefined {
	const fromEnv = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	if (fromEnv) return fromEnv;
	try {
		const payload = JSON.parse(wrangler(["whoami", "--json"])) as {
			account?: { id?: string };
			accounts?: Array<{ id?: string }>;
		};
		return payload.account?.id ?? payload.accounts?.[0]?.id;
	} catch {
		return undefined;
	}
}

async function resolveQueueId(
	token: string,
	accountId: string,
	queueName: string,
): Promise<string> {
	// Field names have drifted across Queues API versions (queue_id/queue_name vs
	// id/name); accept either rather than pinning to whichever is current today.
	const queues = await cfApi<Array<Record<string, unknown>>>(
		token,
		`/accounts/${accountId}/queues`,
	);
	for (const queue of queues) {
		const name = (queue.queue_name ?? queue.name) as string | undefined;
		const id = (queue.queue_id ?? queue.id) as string | undefined;
		if (name === queueName && id) return id;
	}
	throw new Error(`queue ${queueName} not found in account ${accountId}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const args = parseArgs(process.argv.slice(2));
const envName = args.env ?? "dev";
const mailboxId = args.mailbox?.trim();
const apply = args.apply === "true";
const force = args.force === "true";
const timeoutMs = Number(args["timeout-ms"] ?? "60000");
const limit = args.limit ? Number(args.limit) : Number.POSITIVE_INFINITY;

if (!mailboxId) {
	fail("pass --mailbox <mailbox-id>.");
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
	fail("--timeout-ms must be a positive number of milliseconds.");
}

const config = JSON.parse(
	stripJsonc(readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8")),
) as WranglerConfig;
const block: WranglerBlock | undefined = envName === "production" ? config : config.env?.[envName];
if (!block) {
	fail(`wrangler.jsonc has no env "${envName}".`);
}

const targetDb = block.d1_databases?.find((db) => db.binding === "INDEX_DB")?.database_name;
const bucketBinding = block.r2_buckets?.find((r2) => r2.binding === "MAIL_OBJECTS");
const bucket = bucketBinding?.bucket_name;
const bucketJurisdiction = bucketBinding?.jurisdiction;
const queueName = block.queues?.producers?.find(
	(producer) => producer.binding === "INBOUND_EMAIL_QUEUE",
)?.queue;
if (!targetDb || !bucket || !queueName) {
	fail(`env "${envName}" is missing an INDEX_DB, MAIL_OBJECTS or INBOUND_EMAIL_QUEUE binding.`);
}

// `production` is the top-level config block, not an entry under `env`, so wrangler
// rejects `--env production`. Only named environments get the flag.
const envArgs = envName === "production" ? [] : ["--env", envName];

// The migration that motivated this script also moved D1, so what the mailbox used
// to contain and where it is being rebuilt are two different databases. Defaulting
// to the target keeps the ordinary "replay into the same env" case a one-flag run.
const sourceDb = args["source-d1"]?.trim() || targetDb;

console.log("Mailbox re-ingest");
console.log(`  Env:            ${envName}`);
console.log(`  Mailbox:        ${mailboxId}`);
console.log(`  Source D1:      ${sourceDb}${sourceDb === targetDb ? " (same as target)" : ""}`);
console.log(`  Target D1:      ${targetDb}`);
console.log(
	`  R2 bucket:      ${bucket}${bucketJurisdiction ? ` (jurisdiction ${bucketJurisdiction})` : ""}`,
);
console.log(`  Inbound queue:  ${queueName}`);
console.log(`  Mode:           ${apply ? "APPLY" : "DRY RUN (pass --apply to write)"}`);
console.log();

const mailboxRows = d1Query<{ primary_address: string }>(
	sourceDb,
	`SELECT primary_address FROM mailboxes WHERE mailbox_id = ${sqlString(mailboxId)};`,
);
const primaryAddress = mailboxRows[0]?.primary_address?.trim().toLowerCase();
if (!primaryAddress) {
	fail(`no mailboxes row for ${mailboxId} in ${sourceDb}.`);
}

// The address the mail was actually delivered to is not stored anywhere — R2's
// custom metadata does not carry it and message_index only keeps the parsed To.
// The primary address is the closest honest stand-in, and the only thing the DO
// does with it is derive the mailbox's own domain for the subject-threading
// fallback (see mailboxOwnDomains), where any address on the mailbox is equivalent.
const recipient = primaryAddress;
const domain = recipient.split("@")[1] ?? "";

const indexRows = d1Query<MessageIndexRow>(
	sourceDb,
	`SELECT message_local_id, rfc_message_id, subject, from_addr, received_at,
          labels_json, state, raw_r2_key, raw_sha256
     FROM message_index
    WHERE mailbox_id = ${sqlString(mailboxId)}
    ORDER BY received_at ASC;`,
);

if (indexRows.length === 0) {
	fail(`message_index in ${sourceDb} has no rows for ${mailboxId}; nothing to re-ingest.`);
}

console.log(`Enumerated ${indexRows.length} indexed message(s) in ${sourceDb}.`);
console.log();

const workDir = mkdtempSync(join(tmpdir(), "reccado-reingest-raw-"));
const rebuildable: Rebuildable[] = [];
const unrebuildable: Unrebuildable[] = [];

try {
	for (const row of indexRows) {
		if (rebuildable.length >= limit) break;

		const rawBytes = fetchRawObject(bucket, row.raw_r2_key, workDir, bucketJurisdiction);
		if (!rawBytes) {
			unrebuildable.push({ row, reason: `no object at R2 key ${row.raw_r2_key}` });
			continue;
		}

		const notes: string[] = [];
		const actualSha = await sha256Hex(rawBytes);
		if (actualSha !== row.raw_sha256) {
			// The raw object is the rebuild source and its digest is half the
			// idempotency key. A mismatch means the object under this key is not the
			// message the index describes, and replaying it would store something
			// nobody asked for under a key that claims otherwise.
			unrebuildable.push({
				row,
				reason: `raw_sha256 mismatch: index says ${row.raw_sha256}, R2 object hashes to ${actualSha}`,
			});
			continue;
		}

		const parsed = await parseMimeBytes(rawBytes);
		const indexedMessageId = normalizeMessageId(row.rfc_message_id);
		const parsedMessageId = normalizeMessageId(parsed.messageId);
		if (indexedMessageId && parsedMessageId && indexedMessageId !== parsedMessageId) {
			notes.push(`Message-ID differs (index ${indexedMessageId}, MIME ${parsedMessageId})`);
		}
		// The index value wins: it is what the original idempotency key was computed
		// from, so using it is what makes the replay dedupe against the first delivery.
		const messageId = indexedMessageId ?? parsedMessageId;

		// raw_r2_key embeds the original receivedAt as epoch ms (see rawEmailR2Key), so
		// key and index are two independent records of the same instant and can be
		// checked against each other for free.
		const keyEpoch = Number(row.raw_r2_key.split("/").pop()?.split("-")[0]);
		if (Number.isFinite(keyEpoch) && Math.abs(keyEpoch - Date.parse(row.received_at)) > 1000) {
			notes.push(
				`received_at ${row.received_at} disagrees with the timestamp in raw_r2_key (${new Date(keyEpoch).toISOString()})`,
			);
		}

		const idempotencyKey = inboundIdempotencyKey({
			mailboxId,
			messageId,
			rawSha256: row.raw_sha256,
		});

		const payload = inboundEmailQueueMessageSchema.parse({
			schemaVersion: 1,
			eventType: "email.received.v1",
			traceId: randomTraceId(),
			enqueuedAt: new Date().toISOString(),
			receivedAt: row.received_at,
			mailboxId,
			domain,
			recipient,
			sender: row.from_addr,
			rawR2Key: row.raw_r2_key,
			rawSha256: row.raw_sha256,
			rawSize: rawBytes.byteLength,
			messageId,
			headers: {
				subject: parsed.subject ?? row.subject,
				// The original stored the verbatim `Date:` header line; postal-mime
				// normalizes it to ISO-8601. Same instant, different spelling, and
				// `date_header` is only ever displayed or quoted — noted, not hidden.
				date: parsed.date,
				inReplyTo: normalizeMessageId(parsed.inReplyTo),
				references: parsed.references
					.map((reference) => normalizeMessageId(reference))
					.filter((reference): reference is string => Boolean(reference)),
			},
			routing: { ruleId: null, action: "store", matchedAlias: recipient },
			idempotencyKey,
		}) satisfies InboundEmailQueueMessage;

		const payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
		if (payloadBytes > MAX_QUEUE_BYTES) {
			unrebuildable.push({
				row,
				reason: `queue payload would be ${payloadBytes} bytes, over the ${MAX_QUEUE_BYTES} limit`,
			});
			continue;
		}

		rebuildable.push({ row, payload, rawSize: rawBytes.byteLength, notes });
	}
} finally {
	rmSync(workDir, { recursive: true, force: true });
}

const duplicateKeys = new Map<string, string[]>();
for (const candidate of rebuildable) {
	const seen = duplicateKeys.get(candidate.payload.idempotencyKey) ?? [];
	seen.push(candidate.row.message_local_id);
	duplicateKeys.set(candidate.payload.idempotencyKey, seen);
}
const collisions = [...duplicateKeys.entries()].filter(([, ids]) => ids.length > 1);

// What the target already knows. `ingest_events` is written by the queue consumer
// after the DO answers, for both `inserted` and `duplicate`, so a row here means
// the message is in the rebuilt DO and there is nothing to push.
const alreadyProcessed = new Map<string, IngestEventRow>();
if (rebuildable.length > 0) {
	const keys = rebuildable.map((candidate) => sqlString(candidate.payload.idempotencyKey));
	const rows = d1Query<IngestEventRow>(
		targetDb,
		`SELECT idempotency_key, message_local_id, status, error_code
       FROM ingest_events WHERE idempotency_key IN (${keys.join(", ")});`,
		envArgs,
	);
	for (const row of rows) {
		alreadyProcessed.set(row.idempotency_key, row);
	}
}

console.log("Rebuildable from R2");
console.log("-------------------");
rebuildable.forEach((candidate, position) => {
	const { row, payload } = candidate;
	const existing = alreadyProcessed.get(payload.idempotencyKey);
	const plan = existing
		? force
			? `RE-PUSH (already ${existing.status} in ${targetDb}; --force)`
			: `SKIP (already ${existing.status} in ${targetDb} as ${existing.message_local_id ?? "?"})`
		: "PUSH";
	console.log(
		`  [${String(position + 1).padStart(2, " ")}/${rebuildable.length}] ${row.received_at}  ${plan}`,
	);
	console.log(`         subject   ${row.subject ?? "(none)"}`);
	console.log(`         from      ${row.from_addr}`);
	console.log(`         raw       ${row.raw_r2_key} (${candidate.rawSize} bytes)`);
	console.log(`         idem      ${payload.idempotencyKey}`);
	console.log(`         old id    ${row.message_local_id}  state=${row.state}`);
	for (const note of candidate.notes) {
		console.log(`         note      ${note}`);
	}
});
if (rebuildable.length === 0) {
	console.log("  (none)");
}
console.log();

console.log("Not rebuildable — no raw MIME to replay");
console.log("--------------------------------------");
for (const item of unrebuildable) {
	const outbound = item.row.state === "sent" || item.row.raw_r2_key.startsWith("sent/");
	console.log(`  ${item.row.message_local_id}  state=${item.row.state}  ${item.row.received_at}`);
	console.log(`         subject   ${item.row.subject ?? "(none)"}`);
	console.log(`         reason    ${item.reason}`);
	// Outbound messages never had a raw object: the send path computes
	// `sent/<draftId>` as a key and writes nothing there. Anything else missing its
	// raw object is a loss nobody has accounted for, and saying so here is cheaper
	// than discovering it during verification.
	console.log(
		outbound
			? "         expected  yes — outbound, its body only ever lived in the old DO"
			: "         expected  NO — inbound message with no raw object; investigate before you accept this",
	);
}
if (unrebuildable.length === 0) {
	console.log("  (none)");
}
console.log();

for (const [key, ids] of collisions) {
	console.log(`WARNING: ${ids.length} rows share idempotency key ${key}: ${ids.join(", ")}`);
	console.log("         Only one of them can exist in the DO; the rest will report as duplicates.");
}
if (collisions.length > 0) console.log();

const toPush = rebuildable.filter(
	(candidate) => force || !alreadyProcessed.has(candidate.payload.idempotencyKey),
);

console.log("Plan");
console.log("----");
console.log(`  indexed            ${indexRows.length}`);
console.log(`  rebuildable        ${rebuildable.length}`);
console.log(`  not rebuildable    ${unrebuildable.length}`);
console.log(`  already in target  ${rebuildable.length - toPush.length}`);
console.log(`  to push            ${toPush.length}`);

const stateRestores = rebuildable.filter(
	(candidate) => candidate.row.state !== "inbox" || candidate.row.labels_json !== "[]",
);
const doStateDivergence = rebuildable.filter((candidate) => candidate.row.state !== "inbox");
console.log(`  state/labels to restore in ${targetDb}: ${stateRestores.length}`);
console.log(
	`  messages whose DO state is not the ingest default 'inbox': ${doStateDivergence.length}`,
);
console.log();

if (!apply) {
	console.log("DRY RUN: nothing was pushed and no row was written.");
	console.log("Re-run with --apply to replay the messages listed above.");
	process.exit(0);
}

// Two ways to get a message onto the queue, because publishing has no wrangler
// command. The REST API is the direct one but needs an API token with Queues:Edit,
// which is a credential someone has to mint. `--push-url` is the alternative: a
// Worker holding a producer binding to this queue, which needs nothing but the
// wrangler session that deployed it. Both end at the same `send()`.
const pushUrl = args["push-url"]?.trim();
const pushToken = (args["push-token"] ?? process.env.RECCADO_PUSH_TOKEN)?.trim();
let publish: (payload: unknown) => Promise<void>;

if (pushUrl) {
	console.log(`Pushing to queue ${queueName} via ${new URL(pushUrl).origin}.`);
	publish = async (payload) => {
		const response = await fetch(pushUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(pushToken ? { authorization: `Bearer ${pushToken}` } : {}),
			},
			body: JSON.stringify(payload),
		});
		if (!response.ok) {
			throw new Error(`push endpoint returned ${response.status}: ${await response.text()}`);
		}
	};
} else {
	const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
	if (!apiToken) {
		fail(
			"--apply needs CLOUDFLARE_API_TOKEN (Queues:Edit), or --push-url pointing at a Worker with a producer binding for this queue.",
		);
	}
	const accountId = resolveAccountId();
	if (!accountId) {
		fail("could not resolve an account id; set CLOUDFLARE_ACCOUNT_ID.");
	}
	const queueId = await resolveQueueId(apiToken, accountId, queueName);
	console.log(`Pushing to queue ${queueName} (${queueId}) in account ${accountId}.`);
	publish = async (payload) => {
		await cfApi(apiToken, `/accounts/${accountId}/queues/${queueId}/messages`, {
			method: "POST",
			body: JSON.stringify({ body: payload, content_type: "json" }),
		});
	};
}
console.log();

const outcomes: Outcome[] = [];

for (const candidate of rebuildable) {
	const { row, payload } = candidate;
	const label = `${row.received_at} ${row.subject ?? "(no subject)"}`;

	if (!force && alreadyProcessed.has(payload.idempotencyKey)) {
		const existing = alreadyProcessed.get(payload.idempotencyKey)!;
		outcomes.push({
			row,
			status: "skipped",
			detail: `already ${existing.status} in ${targetDb}`,
			newLocalId: existing.message_local_id,
		});
		console.log(`  SKIP      ${label} — already ${existing.status} in ${targetDb}`);
		continue;
	}

	try {
		await publish(payload);
	} catch (error) {
		outcomes.push({
			row,
			status: "push_failed",
			detail: error instanceof Error ? error.message : String(error),
			newLocalId: null,
		});
		console.log(`  PUSH-FAIL ${label} — ${error instanceof Error ? error.message : error}`);
		continue;
	}

	// Wait for this message to land before pushing the next one; see the ordering
	// note at the top of this file.
	// A row carrying this idempotency key may already exist before we push -- the
	// projection is rebuildable and can be restored from a backup that predates the
	// Durable Object it describes, which is exactly the state a jurisdiction move
	// leaves behind. Waiting for "a row exists" would then be satisfied instantly by
	// that stale row and report work that never happened, reusing the old message id.
	// So completion means the id *changed*, not that a row is present.
	const priorLocalId = alreadyProcessed.get(payload.idempotencyKey)?.message_local_id ?? null;
	const deadline = Date.now() + timeoutMs;
	let settled: IngestEventRow | undefined;
	while (Date.now() < deadline) {
		await sleep(1500);
		const rows = d1Query<IngestEventRow>(
			targetDb,
			`SELECT idempotency_key, message_local_id, status, error_code
         FROM ingest_events WHERE idempotency_key = ${sqlString(payload.idempotencyKey)};`,
			envArgs,
		);
		const row0 = rows[0];
		if (!row0 || (row0.status !== "processed" && row0.status !== "failed")) continue;
		if (priorLocalId !== null && row0.message_local_id === priorLocalId) continue;
		settled = row0;
		break;
	}

	// Timing out against an unchanged pre-existing row is genuinely ambiguous: the
	// Durable Object either deduplicated this message or never processed it, and a
	// stale projection row cannot tell those apart. Say so instead of picking one.
	if (!settled && priorLocalId !== null) {
		outcomes.push({
			row,
			status: "unverified",
			detail: `a pre-existing ${targetDb} row for this key was unchanged after ${timeoutMs}ms — the DO either deduplicated it or never processed it, and this row predates the run`,
			newLocalId: priorLocalId,
		});
		console.log(
			`  UNVERIFIED ${label} — pre-existing row unchanged; cannot distinguish dedupe from no-op`,
		);
		continue;
	}

	if (!settled) {
		outcomes.push({
			row,
			status: "timeout",
			detail: `no ingest_events row in ${targetDb} after ${timeoutMs}ms`,
			newLocalId: null,
		});
		console.log(`  TIMEOUT   ${label} — no ingest_events row in ${targetDb} after ${timeoutMs}ms`);
		continue;
	}
	if (settled.status === "failed") {
		outcomes.push({
			row,
			status: "conflict",
			detail: settled.error_code ?? "failed",
			newLocalId: null,
		});
		console.log(`  CONFLICT  ${label} — ${settled.error_code ?? "failed"}`);
		continue;
	}

	// `duplicate` is only claimed when the Durable Object itself reported one, never
	// inferred from a projection row we did not watch appear.
	const reused = settled.message_local_id === priorLocalId;
	outcomes.push({
		row,
		status: reused ? "duplicate" : "inserted",
		detail: settled.message_local_id ?? "",
		newLocalId: settled.message_local_id,
	});
	console.log(
		`  ${reused ? "DUPLICATE" : "INSERTED "} ${label} → ${settled.message_local_id ?? "?"}`,
	);
}

console.log();

// Restore what the ingest path cannot know. A replayed message is inbound and lands
// in 'inbox' with no labels, because that is what an arriving email is; the folder it
// had been filed into and the labels put on it live only in message_index, so they
// are copied forward onto the row the consumer just wrote under the new local id.
const restorable = outcomes.filter(
	(outcome) =>
		outcome.newLocalId &&
		(outcome.row.state !== "inbox" || outcome.row.labels_json !== "[]") &&
		(outcome.status === "inserted" ||
			outcome.status === "duplicate" ||
			outcome.status === "skipped"),
);

if (restorable.length > 0) {
	const now = new Date().toISOString();
	const statements = restorable.map(
		(outcome) =>
			`UPDATE message_index SET state = ${sqlString(outcome.row.state)}, ` +
			`labels_json = ${sqlString(outcome.row.labels_json)}, updated_at = ${sqlString(now)} ` +
			`WHERE mailbox_id = ${sqlString(mailboxId)} AND message_local_id = ${sqlString(outcome.newLocalId!)};`,
	);
	d1Exec(targetDb, statements.join("\n"), envArgs);
	console.log(`Restored state/labels on ${restorable.length} message_index row(s) in ${targetDb}.`);
} else {
	console.log("No state/labels to restore: every replayed message was 'inbox' with no labels.");
}
console.log();

const counts = new Map<Outcome["status"], number>();
for (const outcome of outcomes) {
	counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1);
}

console.log("Summary");
console.log("-------");
for (const status of [
	"inserted",
	"duplicate",
	"unverified",
	"skipped",
	"conflict",
	"timeout",
	"push_failed",
] as const) {
	console.log(`  ${status.padEnd(12, " ")} ${counts.get(status) ?? 0}`);
}
console.log(`  not rebuildable ${unrebuildable.length}`);
console.log();

const notClean = outcomes.filter(
	(outcome) =>
		outcome.status === "conflict" ||
		outcome.status === "timeout" ||
		outcome.status === "push_failed",
);
if (notClean.length > 0) {
	console.log("Did not re-ingest");
	console.log("-----------------");
	for (const outcome of notClean) {
		console.log(`  ${outcome.status.toUpperCase()}  ${outcome.row.message_local_id}`);
		console.log(`         subject ${outcome.row.subject ?? "(none)"}`);
		console.log(`         detail  ${outcome.detail}`);
	}
	console.log();
}

// The DO stores state too, and nothing reachable from here can set it: the only
// route that moves a message between folders is the Access-protected
// POST /api/mailboxes/:id/messages/:id/actions. Rather than pretend the restore
// above covered it, print the exact calls that finish the job.
const doFollowUps = outcomes.filter(
	(outcome) => outcome.newLocalId && outcome.row.state !== "inbox",
);
if (doFollowUps.length > 0) {
	console.log("Durable Object state still needs a follow-up");
	console.log("-------------------------------------------");
	console.log(
		"message_index now says these are filed elsewhere, but the DO — which is what the UI reads —",
	);
	console.log("has them in 'inbox'. Apply each with an authenticated request:");
	for (const outcome of doFollowUps) {
		const action =
			outcome.row.state === "archive"
				? "archive"
				: outcome.row.state === "trash"
					? "trash"
					: `(no action maps to state '${outcome.row.state}')`;
		console.log(
			`  POST /api/mailboxes/${mailboxId}/messages/${outcome.newLocalId}/actions  {"action":"${action}"}`,
		);
	}
	console.log();
}

if (sourceDb === targetDb) {
	const superseded = outcomes
		.filter((outcome) => outcome.newLocalId && outcome.newLocalId !== outcome.row.message_local_id)
		.map((outcome) => outcome.row.message_local_id);
	if (superseded.length > 0) {
		console.log("Superseded message_index rows");
		console.log("----------------------------");
		console.log(
			"Re-ingest mints a new message_local_id, so the pre-rebuild rows are still in this",
		);
		console.log("database pointing at DO messages that no longer exist. Delete them when you have");
		console.log("confirmed the rebuild (verify-mailbox-rebuild.ts), not before:");
		console.log(
			`  DELETE FROM message_index WHERE mailbox_id = ${sqlString(mailboxId)} AND message_local_id IN (${superseded
				.map((id) => sqlString(id))
				.join(", ")});`,
		);
		console.log();
	}
}

const failed =
	(counts.get("conflict") ?? 0) + (counts.get("timeout") ?? 0) + (counts.get("push_failed") ?? 0);
if (failed > 0) {
	console.error(`FAIL: ${failed} message(s) did not re-ingest cleanly. See above.`);
	process.exit(1);
}

console.log(
	`PASS: ${counts.get("inserted") ?? 0} inserted, ${counts.get("duplicate") ?? 0} already present, ` +
		`${counts.get("skipped") ?? 0} skipped. Now run pnpm verify:mailbox-rebuild.`,
);
