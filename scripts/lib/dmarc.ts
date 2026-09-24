/**
 * Reading a published DMARC record and saying whether anyone chose it.
 *
 * Enabling Cloudflare Email Sending on a name auto-creates `_dmarc.<name>` with
 * `v=DMARC1; p=reject;` — enforcing, with no `rua`. setup:sending overrides that
 * for the name it manages, but the same record appears wherever sending was
 * enabled by hand (the zone apex, a second subdomain), and there it sits: a
 * hard-reject policy whose failures are reported to nobody. It passes any
 * "is there a DMARC record" check. This module is what tells it apart.
 *
 * Pure except `lookupTxt`, which takes its fetch as a parameter.
 */
import { normalizeTxtContent } from "#/lib/dns-gate";

/** The provider's auto-created record, as it publishes it. */
export const PROVIDER_AUTO_DMARC = "v=DMARC1; p=reject;";

export type DmarcTags = Record<string, string>;

/** Tags of a DMARC TXT, keys lowercased; null when it is not a DMARC record. */
export function parseDmarcTags(txt: string): DmarcTags | null {
	const content = normalizeTxtContent(txt);
	if (!/^v\s*=\s*dmarc1\b/i.test(content)) return null;
	const tags: DmarcTags = {};
	for (const part of content.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const key = part.slice(0, eq).trim().toLowerCase();
		if (key) tags[key] = part.slice(eq + 1).trim();
	}
	return tags;
}

export function isProviderAutoDmarc(txt: string): boolean {
	const content = normalizeTxtContent(txt).replace(/\s+/g, " ").trim();
	return content === PROVIDER_AUTO_DMARC || content === PROVIDER_AUTO_DMARC.slice(0, -1);
}

export type DmarcClassification = {
	status: "pass" | "warn";
	/** The effective `p=` value, or null when there is no single valid record. */
	policy: string | null;
	message: string;
};

/**
 * One verdict per `_dmarc.<domain>`, from the TXT strings published there.
 *
 * Warns on: no record, more than one (RFC 7489 then treats the policy as
 * absent), the provider's auto-created signature, and an enforcing policy with
 * no `rua` — the combination where mail is being rejected or quarantined and
 * nobody receives the reports that would say which.
 */
export function classifyDmarc(domain: string, txtRecords: string[]): DmarcClassification {
	const name = `_dmarc.${domain}`;
	const dmarc = txtRecords.filter((txt) => parseDmarcTags(txt) !== null);
	if (dmarc.length === 0) {
		return {
			status: "warn",
			policy: null,
			message: `${name}: no DMARC record — receivers fall back to the organizational domain's policy, which nobody here set for this name.`,
		};
	}
	if (dmarc.length > 1) {
		return {
			status: "warn",
			policy: null,
			message: `${name}: ${dmarc.length} DMARC records — RFC 7489 treats the policy as absent until exactly one remains.`,
		};
	}
	const raw = normalizeTxtContent(dmarc[0] ?? "");
	const tags = parseDmarcTags(raw) ?? {};
	const policy = tags.p?.toLowerCase() ?? null;
	if (isProviderAutoDmarc(raw)) {
		return {
			status: "warn",
			policy,
			message: `${name}: "${raw}" is the record Email Sending auto-creates — enforcing, with no rua; nobody chose it.`,
		};
	}
	if (policy !== "none" && policy !== "quarantine" && policy !== "reject") {
		return {
			status: "warn",
			policy: null,
			message: `${name}: "${raw}" has no valid p= tag, so receivers ignore it.`,
		};
	}
	if (policy !== "none" && !tags.rua) {
		return {
			status: "warn",
			policy,
			message: `${name}: p=${policy} with no rua — failures are enforced and reported to nobody.`,
		};
	}
	return {
		status: "pass",
		policy,
		message: `${name}: p=${policy}${tags.rua ? `, reports to ${tags.rua}` : " (no rua: monitor mode without reports)"}.`,
	};
}

/**
 * TXT strings from a DNS-over-HTTPS JSON answer (application/dns-json), or null
 * when the response is not a usable answer. NXDOMAIN (Status 3) is an empty
 * list, not an error: "no record" is an answer.
 */
export function parseDohTxtAnswer(payload: unknown): string[] | null {
	if (!payload || typeof payload !== "object") return null;
	const body = payload as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
	if (body.Status === 3) return [];
	if (body.Status !== 0) return null;
	return (body.Answer ?? [])
		.filter((answer) => answer.type === 16 && typeof answer.data === "string")
		.map((answer) => normalizeTxtContent(answer.data ?? ""));
}

/** TXT lookup over Cloudflare DoH. Null on any transport/format failure. */
export async function lookupTxt(
	name: string,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = 5000,
): Promise<string[] | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(
			`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
			{ headers: { accept: "application/dns-json" }, signal: controller.signal },
		);
		if (!response.ok) return null;
		return parseDohTxtAnswer(await response.json());
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
