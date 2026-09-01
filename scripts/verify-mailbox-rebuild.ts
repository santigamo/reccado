#!/usr/bin/env tsx
/**
 * `pnpm verify:mailbox-rebuild` — decides whether a mailbox Durable Object rebuilt
 * by scripts/reingest-mailbox.ts actually contains what it is supposed to contain.
 *
 * The check this script exists to not be: counting the messages that came back. A
 * mailbox that had twenty messages and legitimately loses two comes back at
 * eighteen — and so does a mailbox that loses three, one of them by accident. A
 * count agrees with both stories and distinguishes neither. So every message in the
 * old index is sorted into one of exactly two named sets before anything is counted:
 *
 *   - REBUILDABLE — the raw MIME is still in R2, therefore it must be in the DO.
 *   - KNOWN-LOST  — there is no raw object, therefore it must NOT be in the DO,
 *                   and the reason is named per message rather than implied by
 *                   subtraction. Outbound mail is the whole of this set in
 *                   practice: the send path computes `sent/<draftId>` as an R2 key
 *                   and never writes anything there, so an outbound body only ever
 *                   existed inside the Durable Object.
 *
 * A message present when it was expected to be missing is reported as loudly as one
 * missing when it was expected to be present: it is good news, but it means the loss
 * accounting is wrong, and an accounting that is wrong in the pleasant direction is
 * the same accounting that will be wrong in the other one. Anything in the DO that
 * belongs to neither set fails by name.
 *
 * `--expect-lost` turns the derived KNOWN-LOST set into an assertion. Run once
 * without it, read the list, and pass exactly those ids back — after that, a
 * nineteenth thing quietly failing to come back cannot pass as the accepted loss.
 *
 * Exit codes: 0 every check passed; 1 a discrepancy was found; 2 the verification
 * could not be completed (a required check had no credentials, or the deployment
 * could not be reached) — which is not a pass.
 *
 * Usage:
 *   pnpm verify:mailbox-rebuild --env dev --mailbox mbx_... \
 *     --source-d1 <pre-migration-index> --base-url https://reccado-dev.<sub>.workers.dev
 *
 * Credentials:
 *   PHASE0_DEBUG_TOKEN  the deployed Worker's debug token — reads the DO's own
 *                       message list and R2 heads through /api/debug/phase0/*,
 *                       which is the only route that reports what the Durable
 *                       Object actually holds. Required.
 *   RECCADO_ACCESS_JWT  a Cloudflare Access JWT for an owner identity (the
 *                       CF_Authorization cookie value, or
 *                       `cloudflared access token --app <url>`). Required for the
 *                       full-text search check, and for any request at all when
 *                       the deployment sits behind Access.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type WranglerBlock = {
	d1_databases?: Array<{ binding: string; database_name: string }>;
};

type WranglerConfig = WranglerBlock & { env?: Record<string, WranglerBlock> };

type MessageIndexRow = {
	message_local_id: string;
	thread_id: string;
	subject: string | null;
	received_at: string;
	labels_json: string;
	state: string;
	raw_r2_key: string;
	raw_sha256: string;
};

/** Exactly the shape of debugState() in src/do/mailbox-do.ts. */
type DoMessage = {
	id: string;
	idempotency_key: string;
	raw_r2_key: string;
	raw_sha256: string;
	subject: string | null;
	thread_id: string;
	parse_status: string;
	state: string;
};

type Finding = { level: "fail" | "warn"; text: string };

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

/** Exit 2, not 1: nothing was found to be wrong, the question was never answered. */
function incomplete(message: string): never {
	console.error(`\nVERIFICATION INCOMPLETE: ${message}`);
	process.exit(2);
}

function stripJsonc(input: string): string {
	return input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

// wrangler uploads a `--file` query to R2 before running it, and the JSON it
// returns for an uploaded query carries a *summary* ("Total queries executed",
// "Rows read", ...) in `results` instead of the rows themselves. Silently, with
// success: true. So SELECTs go through `--command`, whose response really does
// carry the rows. The queries here are small enough that the argv limit is not a
// concern, and a query large enough to hit it would be the wrong shape for this
// script anyway.
function d1Query<T>(database: string, sql: string, extraArgs: string[] = []): T[] {
	const raw = execFileSync(
		"pnpm",
		["wrangler", "d1", "execute", database, "--remote", "--json", "--command", sql, ...extraArgs],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
	);
	const start = raw.indexOf("[");
	if (start === -1) {
		throw new Error(`unexpected wrangler d1 output:\n${raw}`);
	}
	const parsed = JSON.parse(raw.slice(start)) as Array<{ results?: T[] }>;
	return parsed[0]?.results ?? [];
}

const args = parseArgs(process.argv.slice(2));
const envName = args.env ?? "dev";
const mailboxId = args.mailbox?.trim();
const baseUrl = (args["base-url"] ?? process.env.RECCADO_BASE_URL)?.trim();
const debugToken = (args["debug-token"] ?? process.env.PHASE0_DEBUG_TOKEN)?.trim();
const accessJwt = (args["access-jwt"] ?? process.env.RECCADO_ACCESS_JWT)?.trim();
const expectLost = (args["expect-lost"] ?? "")
	.split(",")
	.map((id) => id.trim())
	.filter((id) => id.length > 0 && id !== "true");

if (!mailboxId) {
	incomplete("pass --mailbox <mailbox-id>.");
}
if (!baseUrl) {
	incomplete("pass --base-url <https-origin-of-the-deployed-worker>.");
}
if (!debugToken) {
	incomplete(
		"pass --debug-token (or set PHASE0_DEBUG_TOKEN) — /api/debug/phase0/* is the only route " +
			"that reports what the Durable Object holds, and it fails closed without it.",
	);
}

const config = JSON.parse(
	stripJsonc(readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8")),
) as WranglerConfig;
const block: WranglerBlock | undefined = envName === "production" ? config : config.env?.[envName];
if (!block) {
	incomplete(`wrangler.jsonc has no env "${envName}".`);
}
const targetDb = block.d1_databases?.find((db) => db.binding === "INDEX_DB")?.database_name;
if (!targetDb) {
	incomplete(`env "${envName}" has no INDEX_DB binding.`);
}
const sourceDb = args["source-d1"]?.trim() || targetDb;

// `production` is the top-level config block, not an entry under `env`, so wrangler
// rejects `--env production`. Only named environments get the flag.
const envArgs = envName === "production" ? [] : ["--env", envName];

/**
 * Access sits in front of the Worker, so its JWT rides on every request when one is
 * supplied — as both the header the Worker verifies and the cookie the edge does.
 */
function requestHeaders(extra?: Record<string, string>): Record<string, string> {
	const headers: Record<string, string> = { ...extra };
	if (accessJwt) {
		headers["cf-access-jwt-assertion"] = accessJwt;
		headers.cookie = `CF_Authorization=${accessJwt}`;
	}
	return headers;
}

async function getJson<T>(path: string, extraHeaders?: Record<string, string>): Promise<T> {
	const url = new URL(path, baseUrl).toString();
	const response = await fetch(url, {
		headers: requestHeaders(extraHeaders),
		redirect: "manual",
	});
	if (response.status === 302 || response.status === 303) {
		const location = response.headers.get("location") ?? "";
		if (/cloudflareaccess\.com/i.test(location)) {
			incomplete(
				`${url} is behind Cloudflare Access and no usable JWT was supplied. Pass --access-jwt ` +
					"(the CF_Authorization cookie value, or `cloudflared access token --app <url>`).",
			);
		}
		incomplete(`${url} redirected to ${location}`);
	}
	if (response.status === 404) {
		incomplete(
			`${url} returned 404. /api/debug/phase0/* answers 404 when PHASE0_DEBUG_TOKEN is unset ` +
				"on the deployed Worker or does not match the token passed here.",
		);
	}
	if (!response.ok) {
		incomplete(`${url} returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
	}
	return (await response.json()) as T;
}

console.log("Mailbox rebuild verification");
console.log(`  Env:        ${envName}`);
console.log(`  Mailbox:    ${mailboxId}`);
console.log(`  Source D1:  ${sourceDb} (what the mailbox held before the rebuild)`);
console.log(`  Base URL:   ${baseUrl}`);
console.log(`  Access JWT: ${accessJwt ? "supplied" : "absent — the FTS check cannot run"}`);
console.log();

const rawIndexRows = d1Query<MessageIndexRow>(
	sourceDb,
	`SELECT message_local_id, thread_id, subject, received_at,
          labels_json, state, raw_r2_key, raw_sha256
     FROM message_index
    WHERE mailbox_id = ${sqlString(mailboxId)}
    ORDER BY received_at ASC;`,
);
if (rawIndexRows.length === 0) {
	incomplete(
		`message_index in ${sourceDb} has no rows for ${mailboxId}; nothing to verify against.`,
	);
}

const preFindings: Finding[] = [];

// Re-ingest mints a fresh message_local_id, so pointing --source-d1 at the database
// the rebuild also wrote to leaves two rows per message: the pre-rebuild one and the
// one the queue consumer just wrote. They describe the same mail (same raw key, same
// state before the restore), so one is kept — but say which situation this is rather
// than silently expecting every message twice.
const indexRows: MessageIndexRow[] = [];
const seenRawKeys = new Map<string, MessageIndexRow>();
for (const row of rawIndexRows) {
	const first = seenRawKeys.get(row.raw_r2_key);
	if (first) {
		preFindings.push({
			level: "warn",
			text:
				`${sourceDb} has two message_index rows for ${row.raw_r2_key} (${first.message_local_id}, ` +
				`${row.message_local_id}) — that is what a pre-rebuild and a post-rebuild row look like. ` +
				"Point --source-d1 at a database the rebuild did not write to for a clean comparison.",
		});
		continue;
	}
	seenRawKeys.set(row.raw_r2_key, row);
	indexRows.push(row);
}

// Existence is asked of the deployed Worker's own MAIL_OBJECTS binding rather than
// of the R2 API from here: that binding is the one the rebuild reads through, so a
// key it cannot see is a key the rebuild could not have used, whatever a CLI says.
const rebuildable: MessageIndexRow[] = [];
const knownLost: Array<{ row: MessageIndexRow; reason: string; expected: boolean }> = [];

for (const row of indexRows) {
	const head = await getJson<{ exists: boolean; size: number | null }>(
		`/api/debug/phase0/r2/head?key=${encodeURIComponent(row.raw_r2_key)}`,
		{ "x-phase0-debug-token": debugToken },
	);
	if (head.exists) {
		rebuildable.push(row);
		continue;
	}
	// Outbound is the only category with a *reason* for having no raw object.
	// Anything else missing one is an unexplained hole, and it is labelled as such
	// so it cannot ride along inside the accepted loss.
	const outbound = row.state === "sent" || row.raw_r2_key.startsWith("sent/");
	knownLost.push({
		row,
		reason: outbound
			? "outbound: the send path writes no raw object, so the body only ever lived in the old DO"
			: "inbound with no raw object in R2 — unexplained",
		expected: outbound,
	});
}

const snapshot = await getJson<{ messageCount: number; messages: DoMessage[] }>(
	`/api/debug/phase0/mailboxes/${encodeURIComponent(mailboxId)}`,
	{ "x-phase0-debug-token": debugToken },
);

const findings: Finding[] = [...preFindings];
const doByRawKey = new Map<string, DoMessage[]>();
for (const message of snapshot.messages) {
	const bucketed = doByRawKey.get(message.raw_r2_key) ?? [];
	bucketed.push(message);
	doByRawKey.set(message.raw_r2_key, bucketed);
}

console.log("Expected present — rebuildable from R2");
console.log("--------------------------------------");
const presentMatches = new Map<string, DoMessage>();
for (const row of rebuildable) {
	const matches = doByRawKey.get(row.raw_r2_key) ?? [];
	const first = matches[0];
	if (matches.length === 1 && first) {
		presentMatches.set(row.raw_r2_key, first);
		console.log(`  PRESENT  ${row.received_at}  ${row.subject ?? "(no subject)"}`);
		console.log(`           raw ${row.raw_r2_key}`);
		console.log(`           was ${row.message_local_id} → now ${first.id}`);
		if (first.raw_sha256 !== row.raw_sha256) {
			findings.push({
				level: "fail",
				text: `${row.raw_r2_key}: rebuilt raw_sha256 ${first.raw_sha256} != indexed ${row.raw_sha256}`,
			});
		}
		if (first.parse_status !== "parsed") {
			// A message stored with parse_status 'failed' is present but has no body,
			// no snippet and no FTS row. It counts, and it is not recovered.
			findings.push({
				level: "fail",
				text: `${row.raw_r2_key}: rebuilt with parse_status='${first.parse_status}' — the message is stored but its body was not parsed`,
			});
		}
		continue;
	}
	if (matches.length === 0) {
		console.log(`  MISSING  ${row.received_at}  ${row.subject ?? "(no subject)"}`);
		console.log(`           raw ${row.raw_r2_key}  was ${row.message_local_id}`);
		findings.push({
			level: "fail",
			text: `expected present but absent from the DO: ${row.message_local_id} "${row.subject ?? "(no subject)"}" (${row.raw_r2_key})`,
		});
		continue;
	}
	console.log(`  DOUBLED  ${row.received_at}  ${row.subject ?? "(no subject)"}`);
	findings.push({
		level: "fail",
		text: `${row.raw_r2_key} appears ${matches.length} times in the DO (${matches
			.map((match) => match.id)
			.join(", ")}) — the idempotency key did not dedupe`,
	});
}
if (rebuildable.length === 0) console.log("  (none)");
console.log();

// Ingest lands every replayed message in 'inbox' with no labels, because that is what
// an arriving email is. The folder and labels it used to have are copied forward into
// message_index by reingest-mailbox.ts — whether that actually happened is checked
// here rather than assumed. The Durable Object's own state is reported separately: no
// route reachable from a script can set it, so it is the half the restore cannot cover
// and the half the UI actually reads.
console.log("Restored state and labels");
console.log("-------------------------");
const rebuiltIds = [...presentMatches.values()].map((message) => message.id);
const targetIndex = new Map<string, { state: string; labels_json: string }>();
if (rebuiltIds.length > 0) {
	const rows = d1Query<{ message_local_id: string; state: string; labels_json: string }>(
		targetDb,
		`SELECT message_local_id, state, labels_json FROM message_index
      WHERE mailbox_id = ${sqlString(mailboxId)}
        AND message_local_id IN (${rebuiltIds.map((id) => sqlString(id)).join(", ")});`,
		envArgs,
	);
	for (const row of rows) targetIndex.set(row.message_local_id, row);
}
let stateMismatches = 0;
for (const row of rebuildable) {
	const rebuilt = presentMatches.get(row.raw_r2_key);
	if (!rebuilt) continue;
	const indexed = targetIndex.get(rebuilt.id);
	if (!indexed) {
		findings.push({
			level: "fail",
			text: `${rebuilt.id} is in the DO but has no message_index row in ${targetDb} — the mail is stored and the control plane cannot see it`,
		});
		continue;
	}
	if (indexed.state !== row.state || indexed.labels_json !== row.labels_json) {
		stateMismatches += 1;
		findings.push({
			level: "fail",
			text:
				`${rebuilt.id}: ${targetDb} says state='${indexed.state}' labels=${indexed.labels_json}, ` +
				`the pre-rebuild row said state='${row.state}' labels=${row.labels_json} — the restore did not cover it`,
		});
	}
	if (rebuilt.state !== row.state) {
		findings.push({
			level: "warn",
			text:
				`${rebuilt.id} "${row.subject ?? "(no subject)"}" is '${rebuilt.state}' in the Durable Object but was ` +
				`'${row.state}' before the rebuild — apply the follow-up action reingest-mailbox.ts printed`,
		});
	}
}
console.log(`  message_index rows found in ${targetDb}  ${targetIndex.size}/${rebuiltIds.length}`);
console.log(`  state/labels mismatches                  ${stateMismatches}`);
console.log();

console.log("Expected missing — known, accepted losses");
console.log("----------------------------------------");
for (const lost of knownLost) {
	const matches = doByRawKey.get(lost.row.raw_r2_key) ?? [];
	console.log(
		`  ${matches.length === 0 ? "ABSENT " : "PRESENT"}  ${lost.row.received_at}  ${lost.row.subject ?? "(no subject)"}`,
	);
	console.log(`           id ${lost.row.message_local_id}  state=${lost.row.state}`);
	console.log(`           raw ${lost.row.raw_r2_key}`);
	console.log(`           why ${lost.reason}`);
	if (matches.length > 0) {
		findings.push({
			level: "fail",
			text:
				`${lost.row.message_local_id} "${lost.row.subject ?? "(no subject)"}" was expected to be ` +
				"unrecoverable but IS in the rebuilt DO — good news, and it means the loss accounting is wrong",
		});
	}
	if (!lost.expected) {
		findings.push({
			level: "fail",
			text:
				`${lost.row.message_local_id} "${lost.row.subject ?? "(no subject)"}" (state=${lost.row.state}) ` +
				`has no raw object at ${lost.row.raw_r2_key}, and unlike outbound mail there is no reason for that. ` +
				"This is not part of the accepted loss.",
		});
	}
}
if (knownLost.length === 0) console.log("  (none)");
console.log();

// Pinning the set is what turns "eighteen came back" into a statement about which
// eighteen. Without --expect-lost the derived list is printed so it can be pinned.
if (expectLost.length > 0) {
	const derived = new Set(knownLost.map((lost) => lost.row.message_local_id));
	for (const id of expectLost) {
		if (!derived.has(id)) {
			findings.push({
				level: "fail",
				text: `--expect-lost names ${id}, but it is not in the derived known-lost set (it was rebuildable, or it is not in ${sourceDb})`,
			});
		}
	}
	for (const id of derived) {
		if (!expectLost.includes(id)) {
			findings.push({
				level: "fail",
				text: `${id} is unrecoverable but was not named in --expect-lost — an unaccounted loss`,
			});
		}
	}
	console.log(`--expect-lost checked against the derived set (${expectLost.length} id(s)).`);
} else {
	console.log("To pin this accounting for future runs, re-run with:");
	console.log(`  --expect-lost ${knownLost.map((lost) => lost.row.message_local_id).join(",")}`);
}
console.log();

// Everything in the DO must be traceable back to a row we classified. A message
// here belongs to neither set: it is not in the old index at all.
console.log("Unaccounted — in the DO but in neither set");
console.log("-----------------------------------------");
const accountedKeys = new Set([
	...rebuildable.map((row) => row.raw_r2_key),
	...knownLost.map((lost) => lost.row.raw_r2_key),
]);
let unaccounted = 0;
for (const message of snapshot.messages) {
	if (accountedKeys.has(message.raw_r2_key)) continue;
	unaccounted += 1;
	console.log(`  ${message.id}  ${message.subject ?? "(no subject)"}  raw=${message.raw_r2_key}`);
	findings.push({
		level: "fail",
		text: `DO message ${message.id} (${message.raw_r2_key}) matches nothing in ${sourceDb} — it was not part of this mailbox's index`,
	});
}
if (unaccounted === 0) console.log("  (none)");
console.log();

console.log("Counts");
console.log("------");
console.log(`  indexed before the rebuild   ${indexRows.length}`);
console.log(`  rebuildable (raw in R2)      ${rebuildable.length}`);
console.log(`  known-lost (no raw in R2)    ${knownLost.length}`);
console.log(`  present in the DO            ${snapshot.messageCount}`);
console.log(
	`  arithmetic                   ${rebuildable.length} + ${knownLost.length} = ${rebuildable.length + knownLost.length} (indexed ${indexRows.length})`,
);
if (rebuildable.length + knownLost.length !== indexRows.length) {
	findings.push({
		level: "fail",
		text: `classification lost rows: ${rebuildable.length} + ${knownLost.length} != ${indexRows.length}`,
	});
}
if (snapshot.messageCount !== snapshot.messages.length) {
	findings.push({
		level: "fail",
		text: `DO reports messageCount=${snapshot.messageCount} but returned ${snapshot.messages.length} messages`,
	});
}
if (snapshot.messageCount !== rebuildable.length) {
	findings.push({
		level: "fail",
		text: `DO holds ${snapshot.messageCount} messages; ${rebuildable.length} were rebuildable`,
	});
}
console.log();

// Threading is the one thing a replay can get wrong without losing a message: the
// same mail, regrouped. Compare the groupings themselves, not just how many there
// are — two threads merged and two split leaves the count identical.
console.log("Threads");
console.log("-------");
function groupings(entries: Array<{ threadId: string; rawKey: string }>): Map<string, string[]> {
	const byThread = new Map<string, string[]>();
	for (const entry of entries) {
		const members = byThread.get(entry.threadId) ?? [];
		members.push(entry.rawKey);
		byThread.set(entry.threadId, members);
	}
	return byThread;
}

const beforeGroups = groupings(
	rebuildable.map((row) => ({ threadId: row.thread_id, rawKey: row.raw_r2_key })),
);
const afterGroups = groupings(
	snapshot.messages.map((message) => ({
		threadId: message.thread_id,
		rawKey: message.raw_r2_key,
	})),
);
const canonical = (groups: Map<string, string[]>) =>
	new Set([...groups.values()].map((members) => [...members].sort().join("|")));
const beforeShapes = canonical(beforeGroups);
const afterShapes = canonical(afterGroups);

console.log(`  threads before (rebuildable rows only)  ${beforeGroups.size}`);
console.log(`  threads after                           ${afterGroups.size}`);
for (const shape of afterShapes) {
	if (!beforeShapes.has(shape)) {
		findings.push({
			level: "warn",
			text: `rebuilt thread groups differently: [${shape.split("|").join(", ")}]`,
		});
	}
}
if (beforeGroups.size !== afterGroups.size) {
	findings.push({
		level: "warn",
		text: `thread count changed: ${beforeGroups.size} before, ${afterGroups.size} after`,
	});
}
console.log();

// FTS is written inside the same transaction as the message row, so its absence is
// invisible to every check above: the mail is all there and nothing finds it.
console.log("Full-text search");
console.log("----------------");
let ftsChecked = 0;
let ftsSkipped = false;
if (!accessJwt) {
	ftsSkipped = true;
	console.log("  SKIPPED — /api/mailboxes/:id/search is Access-protected; pass --access-jwt.");
} else {
	const probes = snapshot.messages
		.map((message) => {
			const token = (message.subject ?? "")
				.split(/[^\p{L}\p{N}]+/u)
				.filter((word) => word.length >= 4)
				.sort((a, b) => b.length - a.length)[0];
			return token ? { message, token } : null;
		})
		.filter((probe): probe is { message: DoMessage; token: string } => probe !== null)
		.slice(0, 3);

	if (probes.length === 0) {
		ftsSkipped = true;
		console.log("  SKIPPED — no rebuilt message has a subject long enough to probe with.");
	}
	for (const probe of probes) {
		const results = await getJson<{ results: Array<{ message_id: string }> }>(
			`/api/mailboxes/${encodeURIComponent(mailboxId)}/search?q=${encodeURIComponent(probe.token)}&limit=25`,
		);
		const hit = results.results.some((result) => result.message_id === probe.message.id);
		ftsChecked += 1;
		console.log(
			`  ${hit ? "HIT " : "MISS"} "${probe.token}" → ${results.results.length} result(s) for ${probe.message.id}`,
		);
		if (!hit) {
			findings.push({
				level: "fail",
				text: `FTS did not return ${probe.message.id} for a token from its own subject ("${probe.token}") — message_fts was not rebuilt for it`,
			});
		}
	}
}
console.log();

const failures = findings.filter((finding) => finding.level === "fail");
const warnings = findings.filter((finding) => finding.level === "warn");

if (findings.length > 0) {
	console.log("Findings");
	console.log("--------");
	for (const finding of failures) console.log(`  FAIL  ${finding.text}`);
	for (const finding of warnings) console.log(`  WARN  ${finding.text}`);
	console.log();
}

if (failures.length > 0) {
	console.error(
		`FAIL: ${failures.length} discrepanc${failures.length === 1 ? "y" : "ies"}` +
			`${warnings.length > 0 ? ` and ${warnings.length} warning(s)` : ""}. The rebuild is not verified.`,
	);
	process.exit(1);
}

if (ftsSkipped) {
	console.log(
		`Everything checked agrees: ${rebuildable.length} rebuilt, ${knownLost.length} accounted as lost` +
			`${warnings.length > 0 ? `, ${warnings.length} warning(s)` : ""}.`,
	);
	incomplete("the full-text search check did not run, so this is not a pass.");
}

console.log(
	`PASS: ${rebuildable.length} message(s) rebuilt and matched by raw object, ` +
		`${knownLost.length} accounted for as unrecoverable, ${unaccounted} unaccounted, ` +
		`${ftsChecked} FTS probe(s) hit` +
		`${warnings.length > 0 ? `, ${warnings.length} warning(s) above` : ""}.`,
);
