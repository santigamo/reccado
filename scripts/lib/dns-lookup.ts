/**
 * MX lookups over DNS-over-HTTPS, the sibling of `lookupTxt` in ./dmarc.ts.
 *
 * `pnpm onboard` checks what a sending domain publishes (SPF, DKIM, MX, DMARC)
 * from public DNS rather than the zone API, so a dry run needs no
 * CLOUDFLARE_API_TOKEN. Pure except `lookupMx`, which takes its fetch as a
 * parameter.
 */

export type MxAnswer = { priority: number; exchange: string };

/** Lowercased, trailing dot removed. */
export function canonicalHost(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * MX answers from a DoH JSON response (`data` is "<priority> <exchange>"), or
 * null when the response is not a usable answer. NXDOMAIN is an empty list.
 */
export function parseDohMxAnswer(payload: unknown): MxAnswer[] | null {
	if (!payload || typeof payload !== "object") return null;
	const body = payload as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
	if (body.Status === 3) return [];
	if (body.Status !== 0) return null;
	const out: MxAnswer[] = [];
	for (const answer of body.Answer ?? []) {
		if (answer.type !== 15 || typeof answer.data !== "string") continue;
		const [rawPriority, exchange] = answer.data.trim().split(/\s+/, 2);
		const priority = Number.parseInt(rawPriority ?? "", 10);
		if (Number.isNaN(priority) || !exchange) continue;
		out.push({ priority, exchange: canonicalHost(exchange) });
	}
	return out;
}

/** MX lookup over Cloudflare DoH. Null on any transport/format failure. */
export async function lookupMx(
	name: string,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = 5000,
): Promise<MxAnswer[] | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(
			`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=MX`,
			{ headers: { accept: "application/dns-json" }, signal: controller.signal },
		);
		if (!response.ok) return null;
		return parseDohMxAnswer(await response.json());
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
