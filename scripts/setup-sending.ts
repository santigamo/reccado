#!/usr/bin/env tsx
/**
 * `pnpm setup:sending` — prepares Cloudflare Email Sending for a dedicated sending subdomain
 * and updates Reccado's generated Wrangler config to use that sender address.
 *
 * SAFETY: dry-run by default. It prints the exact commands and DNS/API mutations it would make.
 * Pass `--apply` to enable Email Sending for the target subdomain, upsert the DNS records Reccado
 * can own confidently (SPF + DMARC, and — with a token — the provider-generated DKIM + MX records
 * too), and write `wrangler.generated.<env>.json` with MAIL_FROM_ADDRESS + allowed_sender_addresses.
 *
 * PREFLIGHT: sending to arbitrary external recipients requires a Workers Paid plan (free-plan
 * accounts can only send to verified destination addresses). The script prints a loud reminder
 * before it touches anything, but it does not try to detect or gate on your plan — verify it
 * yourself in the Cloudflare dashboard.
 *
 * What it automates:
 *   - chooses a dedicated sending subdomain (`send.<domain>` by default)
 *   - enables Cloudflare Email Sending for that sending domain
 *   - upserts generic DNS records we can safely own:
 *       * SPF on `cf-bounce.<sending-domain>` -> `v=spf1 include:_spf.mx.cloudflare.net ~all`
 *       * DMARC on `_dmarc.<sending-domain>` with a recommended policy
 *   - reads the provider-generated DKIM TXT + MX records via
 *     `wrangler email sending dns get <sending-domain>` (parsed from its plain-text output — this
 *     open-beta command has no `--json` mode) and, when `CLOUDFLARE_API_TOKEN` is set and
 *     `--apply` is passed, upserts them too, unless `--skip-provider-records` is given
 *   - writes MAIL_FROM_ADDRESS (default `hello@send.<domain>`) into a generated config
 *   - narrows the `EMAIL` binding to the chosen sender via `allowed_sender_addresses`
 *   - creates-or-verifies the Email Sending **event subscription** binding the sending domain to
 *     the EMAIL_EVENTS_QUEUE, which is what makes delivered/deferred/bounced/rejected/complained/
 *     failed events exist for it at all. This phase reports `verified` or `unresolved` and exits
 *     non-zero on an unresolved --apply run: a domain that can send but produces no feedback is a
 *     half-built domain, and reporting success on it is what let three features read "no event"
 *     as evidence of nothing sent. Opt out with `--skip-event-subscription` (an explicit
 *     declaration, not silence).
 *
 * DMARC ramp (recommended for a brand-new sending subdomain):
 *   1. Default is `p=none` (monitor mode) with relaxed alignment (`adkim=r; aspf=r`). Pass
 *      `--dmarc-rua you@example.com` so you actually receive aggregate reports in this phase —
 *      without an rua address, monitor mode produces no visibility into DKIM/SPF alignment.
 *   2. Once reports show DKIM/SPF are aligned, re-run with `--dmarc-policy quarantine`.
 *   3. Once quarantine looks clean, re-run with `--dmarc-policy reject` to fully enforce.
 *   Alignment can be tightened with `--dmarc-alignment strict` once you're confident; relaxed is
 *   the safe default and `pct` is omitted entirely while the policy is `none`.
 *   NOTE: the provider's own DKIM/MX output includes a suggested DMARC record too (typically
 *   `p=reject`) — this script never applies it. DMARC stays exclusively owned by the ramp above so
 *   a fresh subdomain is never accidentally hard-enforced before it's been observed.
 *
 * What it deliberately does NOT automate:
 *   - `--skip-provider-records` opts back out of the DKIM/MX auto-add above, for anyone who wants
 *     to hand-manage those via `wrangler email sending dns get <sending-domain>` instead.
 *   - any send path changes: request-send -> confirm-send remains the only outbound flow.
 *
 * Usage:
 *   pnpm setup:sending --env dev --domain example.com
 *   pnpm setup:sending --env dev --domain example.com --subdomain send --from-local-part hello --apply
 *   pnpm setup:sending --env dev --domain example.com --dmarc-rua dmarc@example.com --apply
 *   pnpm setup:sending --env dev --domain example.com --dmarc-policy quarantine --dmarc-alignment strict --apply
 *   pnpm setup:sending --env dev --domain example.com --skip-provider-records --apply
 *
 * Apply mode notes:
 *   - `wrangler email sending enable/get` uses your local Wrangler auth (`pnpm wrangler login`)
 *   - DNS upserts (SPF, DMARC, and — unless --skip-provider-records — DKIM + MX) need
 *     CLOUDFLARE_API_TOKEN in the environment with zone DNS edit access
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	describeFeedbackVerdict,
	EMAIL_SENDING_EVENT_TYPES,
	evaluateFeedbackSubscription,
	helpAdvertisesEmailSendingSource,
	MIN_WRANGLER_FOR_EMAIL_SENDING,
	parseQueueListTable,
	parseSubscriptionListJson,
} from "./lib/event-subscriptions";

type SendEmailBinding = {
	name?: string;
	allowed_sender_addresses?: string[];
};

type WranglerBlock = {
	name?: string;
	vars?: { MAIL_FROM_ADDRESS?: string };
	send_email?: SendEmailBinding[];
	queues?: { producers?: Array<{ binding: string; queue: string }> };
};

type WranglerConfig = WranglerBlock & {
	env?: Record<string, WranglerBlock>;
};

type MutableRecord = {
	id: string;
	type: string;
	name: string;
	content: string;
	ttl?: number;
	proxied?: boolean;
	priority?: number;
};

type TxtRecordRequest = {
	type: "TXT";
	name: string;
	content: string;
	ttl: number;
	comment?: string;
};

type MxRecordRequest = {
	type: "MX";
	name: string;
	content: string;
	priority: number;
	ttl: number;
	comment?: string;
};

// A record parsed out of `wrangler email sending dns get <domain>`'s plain-text output (there is
// no --json mode for this open-beta command). `priority` is only present on MX records.
type ParsedDnsRecord = {
	type: "MX" | "TXT";
	name: string;
	content: string;
	priority?: number;
};

type CloudflareEnvelope<T> = {
	success: boolean;
	errors: Array<{ code: number; message: string }>;
	result: T;
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

function stripJsonc(input: string): string {
	return input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function requireArg(value: string | undefined, flag: string): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		console.error(`setup:sending: ${flag} is required.`);
		process.exit(1);
	}
	return trimmed;
}

function assertDomain(value: string, flag: string): string {
	const normalized = value.trim().toLowerCase().replace(/\.$/, "");
	if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized)) {
		console.error(`setup:sending: invalid ${flag} "${value}".`);
		process.exit(1);
	}
	return normalized;
}

function normalizeSubdomain(raw: string | undefined, zoneDomain: string): string {
	const fallback = raw?.trim() || "send";
	const lowered = fallback.toLowerCase().replace(/\.$/, "");
	const relative = lowered.endsWith(`.${zoneDomain}`)
		? lowered.slice(0, -`.${zoneDomain}`.length)
		: lowered;
	if (!relative || relative === "@" || relative.includes("@")) {
		console.error(`setup:sending: invalid --subdomain "${fallback}".`);
		process.exit(1);
	}
	if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/i.test(relative)) {
		console.error(`setup:sending: invalid --subdomain "${fallback}".`);
		process.exit(1);
	}
	return relative;
}

function normalizeLocalPart(raw: string | undefined): string {
	const value = (raw?.trim() || "hello").toLowerCase();
	if (!/^[a-z0-9._%+-]+$/i.test(value)) {
		console.error(`setup:sending: invalid --from-local-part "${raw}".`);
		process.exit(1);
	}
	return value;
}

function buildDmarcValue(policy: string, alignment: string, rua?: string): string {
	const normalizedPolicy = policy.toLowerCase();
	if (!["none", "quarantine", "reject"].includes(normalizedPolicy)) {
		console.error(
			`setup:sending: invalid --dmarc-policy "${policy}" (use none|quarantine|reject).`,
		);
		process.exit(1);
	}
	const normalizedAlignment = alignment.toLowerCase();
	if (!["relaxed", "strict"].includes(normalizedAlignment)) {
		console.error(`setup:sending: invalid --dmarc-alignment "${alignment}" (use relaxed|strict).`);
		process.exit(1);
	}
	// Relaxed (`r`) is the safe default for a subdomain that hasn't confirmed DKIM/SPF alignment
	// yet; strict (`s`) requires an exact domain match and should only be opted into once ramped.
	const alignmentMode = normalizedAlignment === "strict" ? "s" : "r";
	const tags = [
		"v=DMARC1",
		`p=${normalizedPolicy}`,
		`adkim=${alignmentMode}`,
		`aspf=${alignmentMode}`,
	];
	// `pct` is meaningless in monitor mode (`p=none` never applies any policy action), so omit it.
	if (normalizedPolicy !== "none") {
		tags.push("pct=100");
	}
	if (rua) {
		tags.push(`rua=mailto:${rua}`);
	}
	return tags.join("; ");
}

function wrangler(argv: string[], opts: { capture?: boolean } = {}): string {
	// wrangler prefers CLOUDFLARE_API_TOKEN over the `wrangler login` OAuth session, but this
	// script sets that token ONLY for its own DNS REST calls (a least-privilege Zone·DNS·Edit
	// token). wrangler's `email sending` commands need the operator's full account auth, so strip
	// the token (and the legacy global-key vars) from wrangler's env — it then falls back to the
	// OAuth session, while the script's own fetch() DNS calls keep using the token.
	// Node's child_process omits env keys whose value is undefined, so this removes them for the
	// wrangler subprocess without a `delete` (which trips strict-mode TS on the augmented ProcessEnv).
	const env: Record<string, string | undefined> = { ...process.env };
	env.CLOUDFLARE_API_TOKEN = undefined;
	env.CLOUDFLARE_API_KEY = undefined;
	env.CLOUDFLARE_EMAIL = undefined;
	return execFileSync("pnpm", ["wrangler", ...argv], {
		encoding: "utf8",
		stdio: opts.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "pipe"],
		env: env as NodeJS.ProcessEnv,
	});
}

function runIdempotent(title: string, argv: string[], apply: boolean): void {
	console.log(`\n▸ ${title}\n  $ pnpm wrangler ${argv.join(" ")}`);
	if (!apply) return;
	try {
		wrangler(argv);
	} catch (error) {
		const stderr =
			typeof (error as { stderr?: unknown })?.stderr === "string"
				? (error as { stderr: string }).stderr
				: "";
		const haystack = `${error instanceof Error ? error.message : String(error)}\n${stderr}`;
		if (
			/already exists|already created|already enabled|already taken|already in use|duplicate|409|11009/i.test(
				haystack,
			)
		) {
			console.log("  (already in place — skipping)");
			return;
		}
		if (stderr) console.error(stderr);
		throw error;
	}
}

/**
 * Runs wrangler for its output and reports failure as a value. `runIdempotent`
 * throws, which is right for a mutation the operator asked for; the subscription
 * phase instead has to distinguish "not there yet" from "this CLI cannot do it",
 * and both of those are answers, not crashes.
 */
function wranglerCapture(argv: string[]): { ok: boolean; out: string; err: string } {
	try {
		return { ok: true, out: wrangler(argv, { capture: true }), err: "" };
	} catch (error) {
		const stderr = (error as { stderr?: unknown })?.stderr;
		const stdout = (error as { stdout?: unknown })?.stdout;
		return {
			ok: false,
			out: typeof stdout === "string" ? stdout : "",
			err: typeof stderr === "string" ? stderr : String(error),
		};
	}
}

async function cloudflareRequest<T>(
	token: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json = (await response.json()) as CloudflareEnvelope<T>;
	if (!response.ok || !json.success) {
		const details = json.errors?.map((error) => `${error.code}: ${error.message}`).join("; ");
		throw new Error(`Cloudflare API ${method} ${path} failed${details ? ` (${details})` : ""}.`);
	}
	return json.result;
}

async function resolveZoneId(token: string, domain: string): Promise<string> {
	const result = await cloudflareRequest<Array<{ id: string; name: string }>>(
		token,
		"GET",
		`/zones?name=${encodeURIComponent(domain)}&status=active&per_page=1`,
	);
	const zone = result[0];
	if (!zone) {
		throw new Error(`Cloudflare API could not find an active zone for ${domain}.`);
	}
	return zone.id;
}

async function listTxtRecords(
	token: string,
	zoneId: string,
	name: string,
): Promise<MutableRecord[]> {
	return cloudflareRequest<MutableRecord[]>(
		token,
		"GET",
		`/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}&per_page=100`,
	);
}

/**
 * TXT content as the record actually means it, not as the API happens to spell it.
 *
 * Cloudflare returns provider-provisioned TXT records with their surrounding
 * double quotes inside `content` ("v=spf1 ...") while records created through the
 * API come back bare (v=spf1 ...). Comparing the raw strings therefore fails to
 * recognise an existing record as the same one, and the consequence is not a
 * cosmetic duplicate: `ownsRecord` filters the provider's record out, the upsert
 * concludes nothing exists, and it adds a second record alongside it. For DMARC
 * that is actively broken — two DMARC records at one name mean RFC 7489 treats
 * the policy as absent, so a domain that looks configured is unprotected, and the
 * dedupe below never fires because it only ever sees records it recognises.
 *
 * Observed on notify.eccos.chat: enabling Email Sending auto-provisioned quoted
 * SPF, DKIM and DMARC records, and this script then created unquoted twins of all
 * three, leaving Cloudflare's own `p=reject` DMARC in place next to the ramp's
 * `p=none`.
 */
function normalizeTxtContent(content: string): string {
	// A multi-string TXT ("part one" "part two") concatenates on the wire, so the
	// quotes come out and the parts join.
	return content.trim().replace(/"\s*"/g, "").replace(/^"/, "").replace(/"$/, "").trim();
}

async function upsertTxtStyleRecord(opts: {
	apply: boolean;
	token?: string;
	zoneId?: string;
	name: string;
	styleLabel: string;
	desiredContent: string;
	comment: string;
	ownsRecord: (record: MutableRecord) => boolean;
	// Collapse multiple matching records to one instead of refusing. Needed for DMARC: Cloudflare
	// Email Sending auto-provisions its own DMARC record alongside ours, and two DMARC TXT records
	// at one name are invalid (RFC 7489 treats the policy as absent).
	dedupe?: boolean;
}): Promise<void> {
	const { apply, token, zoneId, name, styleLabel, desiredContent, comment, ownsRecord, dedupe } =
		opts;
	console.log(`\n▸ Ensure ${styleLabel} TXT`);
	console.log(`  name: ${name}`);
	console.log(`  content: ${desiredContent}`);
	if (!apply) return;
	if (!token || !zoneId) {
		throw new Error(`setup:sending: missing Cloudflare API context for ${styleLabel} upsert.`);
	}
	const existing = await listTxtRecords(token, zoneId, name);
	let managed = existing.filter(ownsRecord);
	if (managed.length > 1) {
		if (!dedupe) {
			throw new Error(
				`setup:sending: refusing to modify ${styleLabel} at ${name} because multiple matching TXT records already exist.`,
			);
		}
		// Keep the first, patch it below, delete the rest so exactly one record remains.
		for (const record of managed.slice(1)) {
			await cloudflareRequest(token, "DELETE", `/zones/${zoneId}/dns_records/${record.id}`);
			console.log(`  Removed a duplicate ${styleLabel} record.`);
		}
		managed = managed.slice(0, 1);
	}
	if (managed.length === 1) {
		const current = managed[0];
		if (!current) {
			throw new Error(
				`setup:sending: expected exactly one existing ${styleLabel} record at ${name}.`,
			);
		}
		if (normalizeTxtContent(current.content) === normalizeTxtContent(desiredContent)) {
			console.log("  (already matches — leaving it untouched)");
			return;
		}
		await cloudflareRequest<MutableRecord>(
			token,
			"PATCH",
			`/zones/${zoneId}/dns_records/${current.id}`,
			{
				type: "TXT",
				name,
				content: desiredContent,
				ttl: 1,
				comment,
			} satisfies TxtRecordRequest,
		);
		console.log("  Updated existing TXT record.");
		return;
	}
	await cloudflareRequest<MutableRecord>(token, "POST", `/zones/${zoneId}/dns_records`, {
		type: "TXT",
		name,
		content: desiredContent,
		ttl: 1,
		comment,
	} satisfies TxtRecordRequest);
	console.log("  Created TXT record.");
}

async function listMxRecords(
	token: string,
	zoneId: string,
	name: string,
): Promise<MutableRecord[]> {
	return cloudflareRequest<MutableRecord[]>(
		token,
		"GET",
		`/zones/${zoneId}/dns_records?type=MX&name=${encodeURIComponent(name)}&per_page=100`,
	);
}

async function upsertMxRecord(opts: {
	apply: boolean;
	token?: string;
	zoneId?: string;
	name: string;
	content: string;
	priority: number;
	comment: string;
}): Promise<void> {
	const { apply, token, zoneId, name, content, priority, comment } = opts;
	console.log(
		`\n▸ Ensure MX record\n  name: ${name}\n  content: ${content}\n  priority: ${priority}`,
	);
	if (!apply) return;
	if (!token || !zoneId) {
		throw new Error(`setup:sending: missing Cloudflare API context for MX upsert at ${name}.`);
	}
	// Compare ignoring a trailing dot (Cloudflare/wrangler are inconsistent about it, but both
	// accept either form) so we don't create a duplicate MX record that only differs by "."
	const normalizeMxContent = (value: string) => value.trim().toLowerCase().replace(/\.$/, "");
	const existing = await listMxRecords(token, zoneId, name);
	const match = existing.find(
		(record) => normalizeMxContent(record.content) === normalizeMxContent(content),
	);
	if (match) {
		if (match.priority === priority) {
			console.log("  (already matches — leaving it untouched)");
			return;
		}
		await cloudflareRequest<MutableRecord>(
			token,
			"PATCH",
			`/zones/${zoneId}/dns_records/${match.id}`,
			{
				type: "MX",
				name,
				content,
				priority,
				ttl: 1,
				comment,
			} satisfies MxRecordRequest,
		);
		console.log("  Updated existing MX record's priority.");
		return;
	}
	// Only ever create/patch records that match this exact content — never delete MX records at
	// this name that we didn't create, since other MX records may coexist here.
	await cloudflareRequest<MutableRecord>(token, "POST", `/zones/${zoneId}/dns_records`, {
		type: "MX",
		name,
		content,
		priority,
		ttl: 1,
		comment,
	} satisfies MxRecordRequest);
	console.log("  Created MX record.");
}

function stripSurroundingQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/**
 * Parses the plain-text output of `wrangler email sending dns get <sending-domain>`. This is an
 * open-beta Wrangler command with no `--json` mode (passing `--json` errors with
 * "Unknown argument: json"), so this is the only way to get structured data out of it. The output
 * looks like:
 *
 *   MX record:
 *     Name:     cf-bounce.send.example.com
 *     Content:  route1.mx.cloudflare.net.
 *     Priority: 71
 *     TTL:      1
 *
 * We key off the stable "MX record:" / "TXT record:" block headers and the indented
 * "Name:"/"Content:"/"Priority:"/"TTL:" field labels. That naturally skips the Wrangler version
 * banner and open-beta notice printed above the first block, since neither line matches either
 * pattern — no separate banner-stripping step is needed. Blocks missing a Name/Content (or, for
 * MX, a parseable Priority) are skipped rather than throwing, since this is scraping a
 * human-readable CLI format that could change shape without notice.
 */
function parseWranglerDnsGetOutput(output: string): ParsedDnsRecord[] {
	const records: ParsedDnsRecord[] = [];
	let current: { type: "MX" | "TXT"; fields: Record<string, string> } | null = null;

	const flush = () => {
		const block = current;
		current = null;
		if (!block) return;
		const name = block.fields.name?.trim();
		const rawContent = block.fields.content?.trim();
		if (!name || !rawContent) return; // malformed block — skip defensively
		if (block.type === "MX") {
			const priority = Number.parseInt(block.fields.priority ?? "", 10);
			if (Number.isNaN(priority)) return; // malformed MX block — skip defensively
			records.push({ type: "MX", name, content: rawContent, priority });
			return;
		}
		records.push({ type: "TXT", name, content: stripSurroundingQuotes(rawContent) });
	};

	for (const line of output.split(/\r?\n/)) {
		const header = line.trim().match(/^(MX|TXT) record:$/i);
		if (header) {
			flush();
			const label = header[1]?.toUpperCase();
			current = label === "MX" || label === "TXT" ? { type: label, fields: {} } : null;
			continue;
		}
		if (!current) continue;
		const field = line.match(/^\s{2,}(Name|Content|Priority|TTL):\s*(.*)$/);
		if (field?.[1]) {
			current.fields[field[1].toLowerCase()] = field[2] ?? "";
		}
	}
	flush();
	return records;
}

/**
 * Selects only the provider-generated records this script does not already own: the DKIM TXT
 * (`*._domainkey.<sending-domain>`, content `v=DKIM1...`) and the MX records on
 * `cf-bounce.<sending-domain>`. This is an allowlist, not a denylist, so the SPF TXT
 * (`cf-bounce.<sending-domain>`, `v=spf1...`, already upserted separately above) and the DMARC TXT
 * (`_dmarc.<sending-domain>`) are excluded by construction — never by matching against the
 * provider's suggested policy value — which is what guarantees the provider's `p=reject` DMARC
 * suggestion can never overwrite this script's own DMARC ramp.
 */
function selectProviderRecords(
	records: ParsedDnsRecord[],
	sendingDomain: string,
): { dkim?: ParsedDnsRecord; mx: ParsedDnsRecord[] } {
	const bounceDomain = `cf-bounce.${sendingDomain}`.toLowerCase();
	const dkim = records.find(
		(record) =>
			record.type === "TXT" &&
			record.name.toLowerCase().includes("._domainkey.") &&
			record.content.trim().toLowerCase().startsWith("v=dkim1"),
	);
	const mx = records.filter(
		(record) => record.type === "MX" && record.name.toLowerCase() === bounceDomain,
	);
	return { dkim, mx };
}

const args = parseArgs(process.argv.slice(2));
const apply = args.apply === "true";
const skipProviderRecords = args["skip-provider-records"] === "true";
const skipEventSubscription = args["skip-event-subscription"] === "true";
const targetEnv = args.env;
const envLabel = targetEnv ?? "production";
const zoneDomain = assertDomain(requireArg(args.domain, "--domain"), "--domain");
const subdomain = normalizeSubdomain(args.subdomain, zoneDomain);
const fromLocalPart = normalizeLocalPart(args["from-local-part"]);
const rua = args["dmarc-rua"]?.trim();
const dmarcPolicy = (args["dmarc-policy"] ?? "none").trim().toLowerCase();
const dmarcAlignment = (args["dmarc-alignment"] ?? "relaxed").trim().toLowerCase();
const dmarcValue = buildDmarcValue(dmarcPolicy, dmarcAlignment, rua);
if (dmarcPolicy === "none" && !rua) {
	console.warn(
		'\nWARNING: --dmarc-policy is "none" (monitor mode) and no --dmarc-rua was provided, so ' +
			"you will receive no DMARC aggregate reports and won't be able to observe DKIM/SPF " +
			"alignment before ramping to quarantine/reject. Pass --dmarc-rua you@example.com to fix this.\n",
	);
}
const sendingDomain = `${subdomain}.${zoneDomain}`;
const fromAddress = `${fromLocalPart}@${sendingDomain}`;
const bounceDomain = `cf-bounce.${sendingDomain}`;
const dmarcDomain = `_dmarc.${sendingDomain}`;
const spfValue = "v=spf1 include:_spf.mx.cloudflare.net ~all";
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();

const trackedConfig = JSON.parse(
	stripJsonc(readFileSync("wrangler.jsonc", "utf8")),
) as WranglerConfig;
const configBlock: WranglerBlock | undefined = targetEnv
	? trackedConfig.env?.[targetEnv]
	: trackedConfig;
if (!configBlock) {
	console.error(`setup:sending: no config block for env "${targetEnv}" in wrangler.jsonc.`);
	process.exit(1);
}

const worker = configBlock.name ?? trackedConfig.name;
if (!worker) {
	console.error(`setup:sending: could not resolve the Worker name for env "${envLabel}".`);
	process.exit(1);
}

const generatedConfigPath = `wrangler.generated.${envLabel}.json`;
const sourceConfigPath = existsSync(generatedConfigPath) ? generatedConfigPath : "wrangler.jsonc";
const mutableConfig = JSON.parse(
	stripJsonc(readFileSync(sourceConfigPath, "utf8")),
) as WranglerConfig;
const mutableBlock: WranglerBlock | undefined = targetEnv
	? mutableConfig.env?.[targetEnv]
	: mutableConfig;
if (!mutableBlock) {
	console.error(`setup:sending: no config block for env "${envLabel}" in ${sourceConfigPath}.`);
	process.exit(1);
}

mutableBlock.vars = { ...(mutableBlock.vars ?? {}), MAIL_FROM_ADDRESS: fromAddress };
const emailBinding =
	mutableBlock.send_email?.find((binding) => binding.name === "EMAIL") ??
	mutableBlock.send_email?.[0];
if (emailBinding) {
	const nextAllowed = new Set(emailBinding.allowed_sender_addresses ?? []);
	nextAllowed.add(fromAddress);
	emailBinding.allowed_sender_addresses = [...nextAllowed].sort();
}

console.log(
	`\nReccado setup:sending — env: ${envLabel} · worker: ${worker}` +
		`\nzone: ${zoneDomain}` +
		`\nsending domain: ${sendingDomain}` +
		`\nfrom address: ${fromAddress}` +
		`\nmode: ${apply ? "APPLY (mutating Cloudflare + generated config)" : "dry run (no changes)"}\n`,
);

console.log(`${"═".repeat(72)}`);
console.log("PREFLIGHT: Workers Paid plan required for arbitrary-recipient sending");
console.log(`${"═".repeat(72)}`);
console.log(
	"Cloudflare Email Sending on a free plan can only send to VERIFIED destination addresses.\n" +
		"Sending to arbitrary external recipients requires a Workers Paid plan ($5/mo).\n" +
		"  - Verify your plan: Cloudflare dashboard -> your account -> Plans\n" +
		"  - Upgrade: Cloudflare dashboard -> your account -> Plans -> Workers Paid\n" +
		"This script cannot reliably detect your plan via the API, so this check is manual and does\n" +
		"NOT block --apply — everything below will still run even on a free plan, and sends to\n" +
		"unverified recipients will simply fail silently later if you skip this.",
);
console.log(`${"═".repeat(72)}\n`);

runIdempotent(
	"Enable Cloudflare Email Sending for the sending subdomain",
	["email", "sending", "enable", sendingDomain],
	apply,
);

console.log(
	`\n▸ Render generated Wrangler config with MAIL_FROM_ADDRESS + allowed_sender_addresses`,
);
console.log(`  source: ${sourceConfigPath}`);
console.log(`  target: ${generatedConfigPath}`);
console.log(`  MAIL_FROM_ADDRESS=${fromAddress}`);
if (emailBinding) {
	console.log(
		`  EMAIL.allowed_sender_addresses=${emailBinding.allowed_sender_addresses?.join(", ")}`,
	);
} else {
	console.log("  EMAIL.allowed_sender_addresses not updated (no send_email binding found).");
}
if (apply) {
	writeFileSync(generatedConfigPath, `${JSON.stringify(mutableConfig, null, 2)}\n`);
	console.log(`  Wrote ${generatedConfigPath}.`);
}

let zoneId: string | undefined;
if (apply && token) {
	zoneId = await resolveZoneId(token, zoneDomain);
	console.log(`\n▸ Resolved Cloudflare zone\n  ${zoneDomain} -> ${zoneId}`);
} else if (apply) {
	console.log(
		"\n▸ DNS API upserts skipped\n  CLOUDFLARE_API_TOKEN is unset, so the script will print the exact manual next steps instead of mutating DNS.",
	);
}

if (apply && token && zoneId) {
	await upsertTxtStyleRecord({
		apply,
		token,
		zoneId,
		name: bounceDomain,
		styleLabel: "SPF",
		desiredContent: spfValue,
		comment: "Reccado setup:sending managed SPF for Cloudflare Email Sending bounce subdomain",
		ownsRecord: (record) => normalizeTxtContent(record.content).toLowerCase().startsWith("v=spf1"),
	});
	await upsertTxtStyleRecord({
		apply,
		token,
		zoneId,
		name: dmarcDomain,
		styleLabel: "DMARC",
		desiredContent: dmarcValue,
		comment: "Reccado setup:sending managed DMARC for dedicated sending subdomain",
		ownsRecord: (record) =>
			normalizeTxtContent(record.content).toLowerCase().startsWith("v=dmarc1"),
		// Cloudflare Email Sending provisions its own DMARC; collapse to a single record.
		dedupe: true,
	});
} else {
	console.log(`\n▸ Planned SPF TXT\n  ${bounceDomain} -> ${spfValue}`);
	console.log(`\n▸ Planned DMARC TXT\n  ${dmarcDomain} -> ${dmarcValue}`);
}

console.log(
	`\n▸ Provider-generated DKIM + MX records` +
		`\n  $ pnpm wrangler email sending dns get ${sendingDomain}`,
);
let providerRecords: ParsedDnsRecord[] = [];
if (skipProviderRecords) {
	console.log(
		"  Skipped (--skip-provider-records). Run the command above yourself and add the DKIM TXT\n" +
			"  + MX records it prints — this script will not touch them.",
	);
} else {
	// This is read-only (no CLOUDFLARE_API_TOKEN required), so we can attempt it even in a pure
	// dry run to preview what would be added — but the sending domain may not be enabled yet in
	// that case (Email Sending is only actually enabled above when --apply is passed), so guard
	// against `dns get` failing and fall back to a plain note instead of crashing.
	try {
		const output = wrangler(["email", "sending", "dns", "get", sendingDomain], { capture: true });
		console.log(output);
		providerRecords = parseWranglerDnsGetOutput(output);
	} catch (error) {
		const stderr =
			typeof (error as { stderr?: unknown })?.stderr === "string"
				? (error as { stderr: string }).stderr
				: "";
		console.log(
			`  Could not fetch provider DNS records yet — this is expected if Email Sending isn't\n` +
				`  enabled on ${sendingDomain} yet (e.g. a dry run before --apply, or immediately after\n` +
				"  enabling it). Re-run this script once enablement has propagated, or check manually:\n" +
				`    $ pnpm wrangler email sending dns get ${sendingDomain}`,
		);
		if (stderr.trim()) console.log(`  (${stderr.trim().split("\n")[0]})`);
	}
}

const { dkim, mx } = selectProviderRecords(providerRecords, sendingDomain);

if (!skipProviderRecords) {
	if (apply && token && zoneId) {
		if (dkim) {
			await upsertTxtStyleRecord({
				apply,
				token,
				zoneId,
				name: dkim.name,
				styleLabel: "DKIM",
				desiredContent: dkim.content,
				comment:
					"Reccado setup:sending managed DKIM (provider-generated) for dedicated sending subdomain",
				ownsRecord: (record) =>
					normalizeTxtContent(record.content).toLowerCase().startsWith("v=dkim1"),
			});
		} else {
			console.log(
				"\n▸ DKIM TXT not found yet in provider output (Email Sending may still be " +
					"provisioning) — re-run once `wrangler email sending dns get` shows it.",
			);
		}
		for (const record of mx) {
			await upsertMxRecord({
				apply,
				token,
				zoneId,
				name: record.name,
				content: record.content,
				priority: record.priority ?? 10,
				comment:
					"Reccado setup:sending managed MX (provider-generated) for Cloudflare Email Sending",
			});
		}
	} else if (dkim || mx.length > 0) {
		console.log("\n▸ Planned DKIM + MX records (provider-generated)");
		if (dkim) {
			console.log(`  TXT  ${dkim.name} -> ${dkim.content}`);
		}
		for (const record of mx) {
			console.log(`  MX   ${record.name} -> ${record.content} (priority ${record.priority})`);
		}
		console.log(
			"  These are auto-added once CLOUDFLARE_API_TOKEN is set and you pass --apply.\n" +
				"  Pass --skip-provider-records to opt out and manage them by hand instead.",
		);
	} else if (providerRecords.length > 0) {
		console.log(
			"\n▸ No DKIM/MX records in the provider output yet — Email Sending may still be " +
				"provisioning; re-run once `wrangler email sending dns get` shows them.",
		);
	}
}

// --- Email Sending event subscription ----------------------------------------
//
// Enabling Email Sending on a domain does not give it a feedback channel.
// Lifecycle events (delivered/deferred/bounced/rejected/complained/failed) only
// exist for a domain an event subscription binds to a queue, and until now that
// step lived exclusively in `docs/OPERATIONS.md`. So this script could exit 0
// having provisioned a sending domain structurally incapable of the delivery
// tracking and suppression mirror the rest of Reccado documents — not a missing
// warning, a claim of completion that was false. Three features read the absence
// of events as evidence, and absence is only evidence where presence was
// possible; this phase is what makes presence possible.
//
// Terminal state is therefore verified or unresolved, never silent green, on the
// same contract as `pnpm doctor`: a fix line exact enough to paste.
type SubscriptionOutcome = {
	state: "verified" | "unresolved" | "skipped";
	detail: string;
	fix?: string;
};

const eventsQueue = configBlock.queues?.producers?.find(
	(producer) => producer.binding === "EMAIL_EVENTS_QUEUE",
)?.queue;

const subscriptionOutcome = await ensureEventSubscription();

async function ensureEventSubscription(): Promise<SubscriptionOutcome> {
	console.log(`\n▸ Email Sending event subscription for ${sendingDomain}`);
	if (skipEventSubscription) {
		return {
			state: "skipped",
			detail: "--skip-event-subscription was passed; this run made no claim about feedback.",
		};
	}
	if (!eventsQueue) {
		return {
			state: "unresolved",
			detail: `no EMAIL_EVENTS_QUEUE producer is declared for env "${envLabel}", so there is no queue to subscribe to.`,
			fix: "Add the EMAIL_EVENTS_QUEUE producer to wrangler.jsonc, then re-run.",
		};
	}
	console.log(`  queue: ${eventsQueue}`);
	console.log(`  events: ${EMAIL_SENDING_EVENT_TYPES.join(", ")}`);

	const listed = wranglerCapture(["queues", "subscription", "list", eventsQueue, "--json"]);
	const subscriptions = listed.ok ? parseSubscriptionListJson(listed.out) : null;
	if (!subscriptions) {
		return {
			state: "unresolved",
			detail: `could not read the subscriptions on ${eventsQueue}${listed.err.trim() ? ` (${listed.err.trim().split("\n")[0]})` : ""}.`,
			fix: `pnpm wrangler queues subscription list ${eventsQueue} --json — check you are logged in (pnpm wrangler login) and on wrangler >= ${MIN_WRANGLER_FOR_EMAIL_SENDING}.`,
		};
	}

	// The subscription's destination is a queue *id*; only `queues list` maps ids
	// to names, and without that mapping "it exists" cannot be told from "it
	// exists and points somewhere else".
	const queueList = wranglerCapture(["queues", "list"]);
	const queueId = queueList.ok
		? parseQueueListTable(queueList.out).find((queue) => queue.name === eventsQueue)?.id
		: undefined;
	if (!queueId) {
		return {
			state: "unresolved",
			detail: `queue ${eventsQueue} was not found in this account, so its subscriptions cannot be verified.`,
			fix: `pnpm setup:cloud${targetEnv ? ` --env ${targetEnv}` : ""} --domain ${zoneDomain} --address inbox@${zoneDomain} --apply (or pnpm wrangler queues create ${eventsQueue})`,
		};
	}

	const verdict = evaluateFeedbackSubscription({
		sendingDomain,
		expectedQueueId: queueId,
		subscriptions,
	});
	if (verdict.state === "live") {
		return {
			state: "verified",
			detail: describeFeedbackVerdict(sendingDomain, eventsQueue, verdict),
		};
	}
	console.log(`  ${describeFeedbackVerdict(sendingDomain, eventsQueue, verdict)}`);

	// A zone id is the one input neither wrangler nor the sending-domain list will
	// hand over. An existing subscription in the same zone already carries it, so
	// the second sending domain of a zone needs no token at all; the first one
	// falls back to the same REST lookup the DNS upserts already use.
	const zoneIdForSubscription =
		zoneId ??
		subscriptions.find(
			(sub) =>
				sub.source.type === "email.sending" &&
				sub.source.zone_id &&
				(sub.source.domain?.toLowerCase() === zoneDomain ||
					sub.source.domain?.toLowerCase().endsWith(`.${zoneDomain}`)),
		)?.source.zone_id;

	const createCommand = `pnpm wrangler queues subscription create ${eventsQueue} --source email.sending --zone-id ${zoneIdForSubscription ?? "<zone-id>"} --domain ${sendingDomain} --events ${EMAIL_SENDING_EVENT_TYPES.join(",")}`;

	if (!apply) {
		console.log(`  Would run:\n    $ ${createCommand}`);
		return {
			state: "unresolved",
			detail: "dry run — no subscription was created or verified.",
			fix: `Re-run with --apply, or run: ${createCommand}`,
		};
	}

	// An `update` cannot move a subscription between queues, and one pointed at
	// another queue is not ours to repoint — creating a second alongside it would
	// leave two owners for one fact.
	if (verdict.state === "wrong_queue") {
		return {
			state: "unresolved",
			detail: describeFeedbackVerdict(sendingDomain, eventsQueue, verdict),
			fix: `Delete it (pnpm wrangler queues subscription delete <its-queue> --id ${verdict.subscriptionIds[0]}), then: ${createCommand}`,
		};
	}

	const help = wranglerCapture(["queues", "subscription", "create", "--help"]);
	if (!helpAdvertisesEmailSendingSource(`${help.out}${help.err}`)) {
		return {
			state: "unresolved",
			detail: "this wrangler's `queues subscription create` does not offer --source email.sending.",
			fix: `Upgrade to wrangler >= ${MIN_WRANGLER_FOR_EMAIL_SENDING} (pnpm add -D wrangler@${MIN_WRANGLER_FOR_EMAIL_SENDING}) and re-run, or create it in the dashboard: Queues -> ${eventsQueue} -> Subscriptions -> Subscribe to events -> Email Sending -> ${sendingDomain}, selecting all ${EMAIL_SENDING_EVENT_TYPES.length} message.* events.`,
		};
	}

	// Converge rather than duplicate: a subscription that exists but is switched
	// off or missing event types is fixed in place, because a second subscription
	// for the same domain would make "which one is authoritative" a question
	// nobody wants to answer at 3am.
	if (verdict.state === "disabled" || verdict.state === "partial_events") {
		const id = verdict.subscriptionIds[0] ?? "";
		const updated = wranglerCapture([
			"queues",
			"subscription",
			"update",
			eventsQueue,
			"--id",
			id,
			"--events",
			EMAIL_SENDING_EVENT_TYPES.join(","),
			"--enabled",
			"true",
		]);
		if (!updated.ok) {
			return {
				state: "unresolved",
				detail: `updating subscription ${id} failed${updated.err.trim() ? ` (${updated.err.trim().split("\n")[0]})` : ""}.`,
				fix: `pnpm wrangler queues subscription update ${eventsQueue} --id ${id} --events ${EMAIL_SENDING_EVENT_TYPES.join(",")} --enabled true`,
			};
		}
	} else {
		if (!zoneIdForSubscription) {
			return {
				state: "unresolved",
				detail: `no subscription exists and the zone id for ${zoneDomain} could not be resolved.`,
				fix: `Set CLOUDFLARE_API_TOKEN and re-run with --apply, or read the zone id from the Cloudflare dashboard (zone overview, right-hand column) and run: ${createCommand}`,
			};
		}
		const created = wranglerCapture([
			"queues",
			"subscription",
			"create",
			eventsQueue,
			"--source",
			"email.sending",
			"--zone-id",
			zoneIdForSubscription,
			"--domain",
			sendingDomain,
			"--events",
			EMAIL_SENDING_EVENT_TYPES.join(","),
		]);
		if (!created.ok) {
			return {
				state: "unresolved",
				detail: `creating the subscription failed${created.err.trim() ? ` (${created.err.trim().split("\n")[0]})` : ""}.`,
				fix: createCommand,
			};
		}
	}

	// Re-read rather than trust the mutation's exit code: "verified" has to mean
	// the provider agrees, not that a command returned 0.
	const recheck = wranglerCapture(["queues", "subscription", "list", eventsQueue, "--json"]);
	const after = recheck.ok ? parseSubscriptionListJson(recheck.out) : null;
	const afterVerdict = after
		? evaluateFeedbackSubscription({
				sendingDomain,
				expectedQueueId: queueId,
				subscriptions: after,
			})
		: null;
	if (afterVerdict?.state === "live") {
		return {
			state: "verified",
			detail: describeFeedbackVerdict(sendingDomain, eventsQueue, afterVerdict),
		};
	}
	return {
		state: "unresolved",
		detail: afterVerdict
			? describeFeedbackVerdict(sendingDomain, eventsQueue, afterVerdict)
			: `the subscription list on ${eventsQueue} could not be re-read to confirm the change.`,
		fix: `pnpm wrangler queues subscription list ${eventsQueue} --json`,
	};
}

console.log(`  ${subscriptionOutcome.state.toUpperCase()}: ${subscriptionOutcome.detail}`);
if (subscriptionOutcome.fix) console.log(`  → ${subscriptionOutcome.fix}`);

console.log(`\n${"─".repeat(72)}`);
console.log("Still required / intentionally manual:\n");
if (skipProviderRecords) {
	console.log(
		`- DKIM + MX: run \`wrangler email sending dns get ${sendingDomain}\` yourself and add the ` +
			"DKIM TXT + MX records it prints (--skip-provider-records was passed, so this script " +
			"left them untouched).",
	);
} else if (apply && token) {
	console.log(
		"- DKIM + MX are auto-added above from the provider's own output — nothing left to do here " +
			"unless the provider changes its record shape in a way this parser doesn't recognize.",
	);
} else {
	console.log(
		"- DKIM + MX: set CLOUDFLARE_API_TOKEN and re-run with --apply to auto-add the planned " +
			"records printed above (or pass --skip-provider-records to manage them by hand instead).",
	);
}
if (skipEventSubscription) {
	console.log(
		`- Event subscription: skipped (--skip-event-subscription). Until ${sendingDomain} is bound to ` +
			"the events queue, every send from it stays delivery_status=null and no bounce or complaint " +
			"ever reaches the suppression mirror.",
	);
}
console.log(
	`- Re-deploy through the setup scripts when you want the Worker to use ${fromAddress}; they build the TanStack app and patch dist/server/wrangler.json from ${generatedConfigPath}.`,
);
console.log(
	`    pnpm setup:domain${targetEnv ? ` --env ${targetEnv}` : ""} --hostname app.<your-domain> --apply`,
);
console.log(
	"- Sending to arbitrary recipients still requires a Workers Paid plan; verified-destination-only accounts remain limited by Cloudflare.",
);
console.log(
	"- Reccado's send invariant is unchanged: draft -> request-send -> confirm-send is still the only outbound path.",
);

if (!apply) {
	console.log("\nDry run only. Re-run with --apply to execute against Cloudflare.\n");
}

// A dry run never claimed to have finished, so its unresolved subscription is
// just the plan. An --apply run did claim it, and exiting 0 on a sending domain
// with no feedback channel is the exact lie this phase was added to stop.
if (apply && subscriptionOutcome.state === "unresolved") {
	console.error(
		`\nsetup:sending: UNRESOLVED — ${sendingDomain} can send, but its delivery/bounce/complaint events do not reach Reccado.` +
			`\n  ${subscriptionOutcome.detail}` +
			(subscriptionOutcome.fix ? `\n  → ${subscriptionOutcome.fix}` : "") +
			"\n  Sending still works; delivery tracking and the suppression mirror do not.\n",
	);
	process.exit(1);
}
