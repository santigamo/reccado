#!/usr/bin/env tsx
/**
 * `pnpm smoke:access <url>` — post-deploy assertion that Cloudflare Access is protecting the
 * Worker: an unauthenticated request to /api/health must be redirected to the team's
 * cloudflareaccess.com login (or blocked), NOT answered with 200. Exits non-zero on failure,
 * so it fits a CI / post-deploy gate.
 *
 * Usage: pnpm smoke:access https://reccado-dev.<sub>.workers.dev
 */
export {}; // module scope (top-level await + isolates top-level `const` from other scripts)

const baseUrl = process.argv[2] ?? process.env.SMOKE_URL;
if (!baseUrl) {
	console.error("Usage: pnpm smoke:access <https-base-url>");
	process.exit(1);
}

const url = new URL("/api/health", baseUrl).toString();
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);

try {
	const res = await fetch(url, { redirect: "manual", signal: controller.signal });
	const location = res.headers.get("location") ?? "";
	const redirectedToAccess =
		(res.status === 302 || res.status === 303) && /cloudflareaccess\.com/i.test(location);
	const blocked = res.status === 401 || res.status === 403;

	if (redirectedToAccess) {
		console.log(`PASS: unauthenticated ${url} → ${res.status} to ${location}`);
		process.exit(0);
	}
	if (blocked) {
		// Not open (good), but a WAF/firewall/wrong route can also produce 401/403, so this is
		// weaker evidence than a 302 to cloudflareaccess.com. Pass, but say so.
		console.log(
			`PASS (weak): unauthenticated ${url} blocked with ${res.status} — not open, but not confirmed as an Access login.`,
		);
		process.exit(0);
	}
	if (res.status === 200) {
		console.error(`FAIL: unauthenticated ${url} returned 200 — Access is NOT protecting it.`);
		process.exit(1);
	}
	console.error(
		`FAIL: unauthenticated ${url} returned ${res.status} (expected 302 to cloudflareaccess.com).`,
	);
	process.exit(1);
} catch (error) {
	console.error(`FAIL: could not reach ${url}: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
} finally {
	clearTimeout(timeout);
}
