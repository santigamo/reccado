#!/usr/bin/env tsx
/**
 * `pnpm setup:auth` — the guided path for the Better Auth web perimeter
 * (docs/plans/sending-streams-and-auth.md, Phase 2 item 7).
 *
 * Better Auth in the worker is the issuer: it signs sessions at /login and
 * answers /api/auth/*. The only secret it needs is BETTER_AUTH_SECRET, which
 * this script machine-generates (256-bit, node crypto — no human transcribes
 * entropy) and uploads with `wrangler secret put`.
 *
 * The optional part is the Cloudflare WAF rate-limiting rule for /api/auth/*:
 * Better Auth ships its own database-backed rate limiter, but a zone-level WAF
 * rule keeps brute-force traffic from ever reaching the worker. Creating it
 * needs a zone-scoped CLOUDFLARE_API_TOKEN; without one the script prints the
 * exact dashboard steps and curl shape instead — it never fails on a missing
 * token.
 *
 * SAFETY: dry-run by default. Pass `--apply` to upload the secret (and create
 * the WAF rule when a token is present).
 *
 * Rotating a live BETTER_AUTH_SECRET signs out every current session, so it is
 * never a side effect of asking for something else: `--apply` writes the secret
 * only when the worker does not already have one. Re-running it on a configured
 * deployment -- which is how you add the WAF rule after the fact -- leaves the
 * secret alone. Replacing one is a separate, named request: `--rotate-secret`.
 *
 * Usage:
 *   pnpm setup:auth --url https://inbox.<you.com>                       # print the plan
 *   pnpm setup:auth --env dev --url https://inbox-dev.<you.com> --apply # set the secret
 *   pnpm setup:auth --env dev --url https://inbox-dev.<you.com> --apply --rotate-secret
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

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

type CloudflareEnvelope<T> = {
	success?: boolean;
	errors?: Array<{ code?: number; message?: string }>;
	messages?: Array<{ code?: number; message?: string }>;
	result?: T;
};

function formatApiErrors(payload: CloudflareEnvelope<unknown>): string {
	const items = [...(payload.errors ?? []), ...(payload.messages ?? [])]
		.map((item) => {
			const code = item.code ? ` [${item.code}]` : "";
			return `${item.message ?? "unknown Cloudflare API error"}${code}`;
		})
		.filter(Boolean);
	return items.length > 0 ? items.join("; ") : "unknown Cloudflare API error";
}

async function cfApi<T>(token: string, path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	const payload = (await response.json()) as CloudflareEnvelope<T>;
	if (!response.ok || payload.success !== true || payload.result === undefined) {
		throw new Error(formatApiErrors(payload));
	}
	return payload.result;
}

type Zone = { id?: string; name?: string };

/** The zone id for a hostname, walking up through parent domains. */
async function findZoneId(token: string, hostname: string): Promise<string | null> {
	const parts = hostname.split(".").filter(Boolean);
	for (let i = 0; i < parts.length - 1; i += 1) {
		const candidate = parts.slice(i).join(".");
		const zones = await cfApi<Zone[]>(token, `/zones?name=${encodeURIComponent(candidate)}`);
		const zone = zones.find((z) => z.id && z.name === candidate);
		if (zone?.id) return zone.id;
	}
	return null;
}

const WAF_RULE_DESCRIPTION = "reccado: rate limit /api/auth/*";

type WafRule = {
	description?: string;
	expression?: string;
	action?: string;
	enabled?: boolean;
	ratelimit?: {
		characteristics?: string[];
		period?: number;
		requests_per_period?: number;
		mitigation_timeout?: number;
		requests_to_origin?: boolean;
	};
};

function wafRule(): WafRule {
	return {
		description: WAF_RULE_DESCRIPTION,
		expression: '(http.request.uri.path matches "^/api/auth/")',
		action: "block",
		enabled: true,
		ratelimit: {
			characteristics: ["ip.src"],
			period: 60,
			requests_per_period: 30,
			mitigation_timeout: 600,
			requests_to_origin: true,
		},
	};
}

const wafRuleJson = JSON.stringify({ rules: [wafRule()] }, null, 2);

function printWafManualSteps(baseUrl: string): void {
	console.log(
		`\n▸ WAF rate-limit rule for /api/auth/* (manual — no zone-scoped CLOUDFLARE_API_TOKEN found)` +
			`\n  Better Auth's database-backed rate limiter still applies; this WAF rule is the` +
			`\n  outer layer that drops brute-force traffic before it reaches the worker.` +
			`\n\n  Dashboard: ${baseUrl ? new URL(baseUrl).hostname : "<your-zone>"} → Security → WAF →` +
			`\n  Rate limiting rules → Create rule:` +
			`\n    - Name: ${WAF_RULE_DESCRIPTION}` +
			`\n    - Expression: (http.request.uri.path matches "^/api/auth/")` +
			`\n    - Rate: > 30 requests / 60 seconds, characteristics: IP address (ip.src)` +
			`\n    - Action: Block, mitigation timeout 600s, count requests to origin` +
			`\n\n  Or via the API (phase http_ratelimit entrypoint ruleset for the zone):` +
			`\n    ZONE_ID=<your-zone-id>  # Security → WAF, or GET /zones?name=<domain>` +
			`\n    curl -X PUT "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets/phases/http_ratelimit/entrypoint" \\` +
			`\n      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \\` +
			`\n      --data '${wafRuleJson.replace(/'/g, "'\\''")}'` +
			`\n\n  (The PUT replaces the phase entrypoint ruleset's rules — include any existing` +
			`\n  rate-limiting rules you already have in the same request.)`,
	);
}

async function applyWafRule(token: string, hostname: string, dryRun: boolean): Promise<void> {
	console.log(`\n▸ WAF rate-limit rule for /api/auth/* (zone of ${hostname})`);
	const zoneId = await findZoneId(token, hostname);
	if (!zoneId) {
		console.log("  Could not resolve a zone for this hostname; use the manual steps below.");
		printWafManualSteps(hostname ? `https://${hostname}` : "");
		return;
	}
	const path = `/zones/${zoneId}/rulesets/phases/http_ratelimit/entrypoint`;
	if (dryRun) {
		console.log("  Dry run — the rule this script would PUT to the phase entrypoint ruleset:");
		console.log(
			wafRuleJson
				.split("\n")
				.map((line) => `  ${line}`)
				.join("\n"),
		);
		console.log("\n  Re-run with --apply (and CLOUDFLARE_API_TOKEN) to create it.");
		return;
	}
	const existing = await cfApi<{ rules?: WafRule[] }>(token, path).catch(() => null);
	const rules = existing?.rules ?? [];
	if (rules.some((rule) => rule.description === WAF_RULE_DESCRIPTION)) {
		console.log(`  Rule "${WAF_RULE_DESCRIPTION}" already exists — nothing to do.`);
		return;
	}
	// Merge, never replace: the PUT writes the whole rules list.
	await cfApi<unknown>(token, path, {
		method: "PUT",
		body: JSON.stringify({ rules: [...rules, wafRule()] }),
	});
	console.log(`  Created rule "${WAF_RULE_DESCRIPTION}" (30 req/min per IP, block 600s).`);
}

const args = parseArgs(process.argv.slice(2));
const apply = args.apply === "true";
const targetEnv = args.env;
const baseUrl = args.url?.trim().replace(/\/+$/, "");
const skipWaf = args["skip-waf"] === "true";
const rotateSecret = args["rotate-secret"] === "true";
const wafAutomated =
	apply &&
	!skipWaf &&
	Boolean(
		args.url &&
			!new URL(args.url.trim()).hostname.endsWith(".workers.dev") &&
			process.env.CLOUDFLARE_API_TOKEN?.trim(),
	);

const config = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as {
	name?: string;
	env?: Record<string, { name?: string }>;
};
const worker = (targetEnv ? config.env?.[targetEnv]?.name : config.name) ?? config.name;
const envFlag = targetEnv ? ["--env", targetEnv] : [];
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
const hostname = baseUrl ? new URL(baseUrl).hostname : undefined;

if (token) {
	console.log(
		"CLOUDFLARE_API_TOKEN found — WAF rule creation will be offered (dry-run prints the rule, --apply creates it).\n",
	);
}

if (apply && !hostname) {
	console.error(
		"setup:auth: --apply with no --url cannot verify what it is configuring.\n" +
			"Pass --url https://<your-host> (the origin the worker serves the UI on).",
	);
	process.exit(1);
}

/**
 * The secrets already set on the target worker, or null when that cannot be
 * determined (worker not deployed yet, no credentials, API unreachable).
 *
 * `--env <name>` is how this worker is addressed; passing `--name` alongside it
 * makes wrangler look for `<name>-<env>` and fail.
 */
function listSecretNames(): string[] | null {
	try {
		const out = execFileSync("pnpm", ["wrangler", "secret", "list", ...envFlag], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const start = out.indexOf("[");
		if (start < 0) return null;
		return (JSON.parse(out.slice(start)) as Array<{ name?: string }>).map((s) => s.name ?? "");
	} catch {
		return null;
	}
}

// Whether the secret gets written is decided before anything is printed, so the
// mode line states what will actually happen. Rotating a live BETTER_AUTH_SECRET
// signs out every session; the WAF rule lives behind the same --apply, so without
// this check "add the rate-limit rule" would silently mean "and log everyone out".
const existingSecrets = apply ? listSecretNames() : null;
const secretAlreadySet = existingSecrets?.includes("BETTER_AUTH_SECRET") ?? false;
const secretUndeterminable = apply && existingSecrets === null;
const willWriteSecret = apply && (rotateSecret || (!secretAlreadySet && !secretUndeterminable));

const secretModePhrase = willWriteSecret
	? secretAlreadySet
		? "ROTATING BETTER_AUTH_SECRET (every current session is signed out)"
		: "uploading BETTER_AUTH_SECRET"
	: secretUndeterminable
		? "not writing BETTER_AUTH_SECRET (could not verify what is already set)"
		: "keeping the existing BETTER_AUTH_SECRET";
const modeLine = apply
	? [secretModePhrase, wafAutomated ? "creating the WAF rate-limit rule" : null]
			.filter(Boolean)
			.join(" + ")
	: "dry run / guide";

console.log(`\nReccado setup:auth — worker: ${worker}\nmode: ${modeLine}\n`);

// ▸ The secret: machine-generated, uploaded as a Worker secret. There is no
// BETTER_AUTH_URL — the issuer trusts the origin it was requested on.
const rotateCommand = `pnpm setup:auth${targetEnv ? ` --env ${targetEnv}` : ""}${baseUrl ? ` --url ${baseUrl}` : ""} --apply --rotate-secret`;

if (secretAlreadySet && !rotateSecret) {
	console.log(`▸ BETTER_AUTH_SECRET is already set on ${worker} — left untouched.`);
	console.log(
		`  Replacing it signs out every current session, so it is not done as a side effect.\n` +
			`  To replace it deliberately:\n` +
			`    $ ${rotateCommand}`,
	);
} else if (secretUndeterminable) {
	console.log(`▸ BETTER_AUTH_SECRET — NOT written: could not read the secrets on ${worker}.`);
	console.log(
		`  \`wrangler secret list${targetEnv ? ` --env ${targetEnv}` : ""}\` failed, so this script cannot tell whether it would be\n` +
			`  creating a secret or replacing a live one. Check the worker exists and you are\n` +
			`  authenticated, then re-run. To write it regardless:\n` +
			`    $ ${rotateCommand}`,
	);
} else {
	console.log(`▸ Generate BETTER_AUTH_SECRET (256-bit) and upload it to ${worker}:`);
	console.log(
		`  $ pnpm setup:auth${targetEnv ? ` --env ${targetEnv}` : ""}${baseUrl ? ` --url ${baseUrl}` : ""} --apply`,
	);
	console.log(
		`  equivalent by hand:\n` +
			`    node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))' |\n` +
			`    pnpm wrangler secret put BETTER_AUTH_SECRET${targetEnv ? ` --env ${targetEnv}` : ""}`,
	);
	if (!apply) {
		console.log("\n  Dry run only — re-run with --apply to upload the secret.");
	} else {
		const secret = randomBytes(32).toString("base64");
		execFileSync("pnpm", ["wrangler", "secret", "put", "BETTER_AUTH_SECRET", ...envFlag], {
			input: secret,
			stdio: ["pipe", "inherit", "inherit"],
		});
		console.log(
			secretAlreadySet
				? "\n  ✓ BETTER_AUTH_SECRET rotated — every session that existed before now is signed out."
				: "\n  ✓ BETTER_AUTH_SECRET uploaded.",
		);
	}
}

// ▸ The base URL and the bootstrap ladder. Registration is closed at the
// issuer: /login only emails an OTP to an address the owner registry
// (owner_identities ∪ OWNER_BOOTSTRAP_EMAILS) vouches for.
console.log(
	`\n▸ Base URL${baseUrl ? `: ${baseUrl}` : " (not derived — pass --url, or read it from the worker's own record)"}:`,
);
if (!baseUrl) {
	console.log(
		"  The worker records its own public origin after the first authenticated UI load:\n" +
			"    pnpm wrangler d1 execute <index-db> --remote --command \\\n" +
			"      \"SELECT value FROM runtime_config WHERE key = 'deployment.origin'\"",
	);
}
console.log(
	`\n▸ First owner login (registration is closed — the registry vouches for the address):`,
);
console.log(
	"  1. Set the bootstrap or register the owner in D1 (both are read together):\n" +
		`       pnpm wrangler secret put OWNER_BOOTSTRAP_EMAILS${targetEnv ? ` --env ${targetEnv}` : ""}\n` +
		"     or:\n" +
		"       pnpm wrangler d1 execute <index-db> --remote --command \\\n" +
		"         \"INSERT INTO owner_identities (kind, identity, linked_at, linked_via) VALUES ('email', 'you@example.com', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'manual')\"\n" +
		"  2. Open /login, request the email OTP, sign in.\n" +
		"  3. Rescue path when mail sending is not configured yet (or the registry is empty):\n" +
		"     mint a pairing code and spend it at /login:\n" +
		"       pnpm wrangler d1 execute <index-db> --remote --command \\\n" +
		"         \"INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by) VALUES ('<code>', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 hours'), 'manual')\"",
);

// ▸ The WAF layer — optional, never fails the script.
if (!skipWaf && hostname && !hostname.endsWith(".workers.dev")) {
	if (token) {
		try {
			await applyWafRule(token, hostname, !apply);
		} catch (error) {
			console.log(
				`  WAF rule creation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			printWafManualSteps(baseUrl ?? "");
			console.log("  This does not affect the auth setup — the perimeter still works without it.");
		}
	} else {
		printWafManualSteps(baseUrl ?? "");
	}
} else if (!skipWaf) {
	console.log(
		`\n▸ WAF rate-limit rule for /api/auth/*: pass --url <custom-host> to configure it` +
			` (needs a zone-scoped CLOUDFLARE_API_TOKEN for the automated path).`,
	);
}

// ▸ Verification.
const verifyUrl = baseUrl ?? "https://<deployed-url>";
console.log(
	`\nThen verify:` +
		`\n  pnpm doctor${targetEnv ? ` --env ${targetEnv}` : ""} --cloud --url ${verifyUrl}` +
		`\n  curl -sS -o /dev/null -w '%{http_code}\\n' ${verifyUrl}/login   # 200, not a redirect` +
		`\n  curl -sS ${verifyUrl}/api/health                               # 200 with dependencies healthy` +
		`\n  and a real login: open ${verifyUrl}/login in a browser and sign in with an OTP.\n`,
);
