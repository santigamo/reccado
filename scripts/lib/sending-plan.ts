/**
 * The pure half of `setup:sending`: which name gets Email Sending, which
 * records it needs, and what its DMARC says. The script owns the side effects;
 * this owns the decisions, so the decisions can be tested without an account.
 */
import { buildDmarcValue, type DmarcAlignment, type DmarcPolicy } from "#/lib/dns-gate";

export type SendingTarget = {
	/** The Cloudflare zone, e.g. `example.com`. */
	zone: string;
	/** The label under the zone (`send`), or null when the target is the zone apex. */
	label: string | null;
	/** The name Email Sending is enabled on: `send.example.com`, or `example.com` for the apex. */
	sendingDomain: string;
	isApex: boolean;
	/** Where the provider's bounce MX + SPF live: `cf-bounce.<sendingDomain>`. */
	bounceDomain: string;
	/** Where this domain's DMARC lives: `_dmarc.<sendingDomain>`. */
	dmarcDomain: string;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const SPF_VALUE = "v=spf1 include:_spf.mx.cloudflare.net ~all";

export function normalizeZone(raw: string | undefined): Result<string> {
	const normalized = (raw ?? "").trim().toLowerCase().replace(/\.$/, "");
	if (!normalized) return { ok: false, error: "--domain is required." };
	if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized)) {
		return { ok: false, error: `invalid --domain "${raw}".` };
	}
	return { ok: true, value: normalized };
}

/**
 * `--subdomain send` (default), `--subdomain send.example.com`, or the apex via
 * `--apex`, `--subdomain @` or `--subdomain example.com`.
 *
 * The apex used to be rejected outright, which is why onboarding a support
 * mailbox that replies as itself (`support@example.com`) had to be done by
 * hand. It is allowed now, but only ever by an explicit spelling: a missing or
 * empty `--subdomain` still means `send`, never the apex.
 */
export function resolveSendingTarget(opts: {
	zone: string;
	subdomain?: string;
	apex?: boolean;
}): Result<SendingTarget> {
	const zone = opts.zone;
	const raw = opts.subdomain?.trim();
	const lowered = raw?.toLowerCase().replace(/\.$/, "");
	const namesApex = lowered === "@" || lowered === zone;

	if (opts.apex && raw && !namesApex) {
		return {
			ok: false,
			error: `--apex conflicts with --subdomain "${raw}"; pass one or the other.`,
		};
	}
	if (opts.apex || namesApex) {
		return { ok: true, value: build(zone, null) };
	}

	const fallback = lowered || "send";
	const relative = fallback.endsWith(`.${zone}`) ? fallback.slice(0, -`.${zone}`.length) : fallback;
	if (!relative || relative.includes("@") || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(relative)) {
		return {
			ok: false,
			error: `invalid --subdomain "${raw ?? ""}" (use a label like "send", or --apex for ${zone} itself).`,
		};
	}
	return { ok: true, value: build(zone, relative) };
}

function build(zone: string, label: string | null): SendingTarget {
	const sendingDomain = label ? `${label}.${zone}` : zone;
	return {
		zone,
		label,
		sendingDomain,
		isApex: label === null,
		bounceDomain: `cf-bounce.${sendingDomain}`,
		dmarcDomain: `_dmarc.${sendingDomain}`,
	};
}

export type DmarcPlan = {
	policy: DmarcPolicy;
	alignment: DmarcAlignment;
	value: string;
	/** Operator-facing warnings to print before anything is touched. */
	warnings: string[];
};

/**
 * The DMARC record `setup:sending` will write.
 *
 * A dedicated subdomain defaults to `p=none`: nothing else sends from it, so
 * monitor mode costs nothing and a mistake cannot bounce anyone's mail.
 *
 * The apex is different in kind. `_dmarc.<zone>` governs every message that
 * claims the organizational domain — the operator's personal mail, a
 * newsletter tool, an invoicing SaaS — and, through `sp=` or its absence, every
 * subdomain that has no record of its own. No default is safe there: `none`
 * silently relaxes a domain that may be enforcing today, and anything stronger
 * can start rejecting senders this script cannot see. So the apex requires the
 * policy to be named, and says why.
 */
export function resolveDmarcPlan(opts: {
	target: SendingTarget;
	policy?: string;
	alignment?: string;
	rua?: string;
}): Result<DmarcPlan> {
	const warnings: string[] = [];
	const rawPolicy = opts.policy?.trim().toLowerCase();
	if (opts.target.isApex && !rawPolicy) {
		return {
			ok: false,
			error:
				`the apex ${opts.target.dmarcDomain} record governs ALL mail from ${opts.target.zone} ` +
				"(every other service sending as it, and every subdomain without its own DMARC), so " +
				"there is no safe default. Check what it says now (dig +short TXT " +
				`${opts.target.dmarcDomain}) and pass --dmarc-policy none|quarantine|reject explicitly ` +
				"(plus --dmarc-rua to keep receiving reports).",
		};
	}
	const policy = rawPolicy || "none";
	if (policy !== "none" && policy !== "quarantine" && policy !== "reject") {
		return {
			ok: false,
			error: `invalid --dmarc-policy "${opts.policy}" (use none|quarantine|reject).`,
		};
	}
	const alignment = opts.alignment?.trim().toLowerCase() || "relaxed";
	if (alignment !== "relaxed" && alignment !== "strict") {
		return {
			ok: false,
			error: `invalid --dmarc-alignment "${opts.alignment}" (use relaxed|strict).`,
		};
	}
	const rua = opts.rua?.trim() || undefined;
	if (policy === "none" && !rua) {
		warnings.push(
			'--dmarc-policy is "none" (monitor mode) and no --dmarc-rua was provided, so you will ' +
				"receive no DMARC aggregate reports and won't be able to observe DKIM/SPF alignment " +
				"before ramping to quarantine/reject. Pass --dmarc-rua you@example.com to fix this.",
		);
	}
	if (opts.target.isApex) {
		warnings.push(
			`APEX DMARC: this run will replace ${opts.target.dmarcDomain} — the policy for EVERY sender ` +
				`using @${opts.target.zone}, not just Reccado — with p=${policy}. Any other v=DMARC1 ` +
				"record there is collapsed into this one.",
		);
	}
	return {
		ok: true,
		value: {
			policy,
			alignment,
			// Built by the gate so the CLI and the Worker spell a policy byte-identically.
			value: buildDmarcValue(policy, alignment, rua),
			warnings,
		},
	};
}

// A record parsed out of `wrangler email sending dns get <domain>`'s plain-text output (there is
// no --json mode for this open-beta command). `priority` is only present on MX records.
export type ParsedDnsRecord = {
	type: "MX" | "TXT";
	name: string;
	content: string;
	priority?: number;
};

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
 * banner and open-beta notice printed above the first block. Blocks missing a Name/Content (or,
 * for MX, a parseable Priority) are skipped rather than throwing, since this is scraping a
 * human-readable CLI format that could change shape without notice.
 */
export function parseWranglerDnsGetOutput(output: string): ParsedDnsRecord[] {
	const records: ParsedDnsRecord[] = [];
	let current: { type: "MX" | "TXT"; fields: Record<string, string> } | null = null;

	const flush = () => {
		const block = current;
		current = null;
		if (!block) return;
		const name = block.fields.name?.trim();
		const rawContent = block.fields.content?.trim();
		if (!name || !rawContent) return;
		if (block.type === "MX") {
			const priority = Number.parseInt(block.fields.priority ?? "", 10);
			if (Number.isNaN(priority)) return;
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
 * (`cf-bounce.<sending-domain>`, `v=spf1...`, upserted separately) and the DMARC TXT
 * (`_dmarc.<sending-domain>`) are excluded by construction — never by matching against the
 * provider's suggested policy value — which is what guarantees the provider's `p=reject` DMARC
 * suggestion can never overwrite this script's own DMARC ramp. For the apex this is what keeps
 * `v=DMARC1; p=reject;` off the organizational domain.
 */
export function selectProviderRecords(
	records: ParsedDnsRecord[],
	sendingDomain: string,
): { dkim?: ParsedDnsRecord; mx: ParsedDnsRecord[] } {
	const bounceDomain = `cf-bounce.${sendingDomain}`.toLowerCase();
	const dkimSuffix = `._domainkey.${sendingDomain}`.toLowerCase();
	const dkim = records.find(
		(record) =>
			record.type === "TXT" &&
			record.name.toLowerCase().replace(/\.$/, "").endsWith(dkimSuffix) &&
			record.content.trim().toLowerCase().startsWith("v=dkim1"),
	);
	const mx = records.filter(
		(record) =>
			record.type === "MX" && record.name.toLowerCase().replace(/\.$/, "") === bounceDomain,
	);
	return { dkim, mx };
}
