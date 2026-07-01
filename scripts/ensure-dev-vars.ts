#!/usr/bin/env tsx
/**
 * Generates a minimal, valid `.dev.vars` for local development if one is missing,
 * so `pnpm dev` works straight from a clone with no manual `cp` step.
 *
 * Why not just copy `.dev.vars.example`? The example documents the *remote* secrets
 * (Cloudflare Access `aud`/team domain, CF API token) with non-empty placeholder
 * values. `getAccessConfigStatus()` (src/lib/runtime-config.ts) only enables the
 * local-dev bypass when BOTH Access vars are empty/absent — so copying the example
 * verbatim would flip local `/api/*` out of bypass and into failed JWT validation.
 * This writes only the two local-safe secrets and intentionally leaves Access unset.
 *
 * Idempotent and non-destructive: if `.dev.vars` already exists it is never touched.
 * Escape hatch: set RECCADO_SKIP_DEV_VARS=1 to skip generation entirely (e.g. CI).
 */
import { existsSync, writeFileSync } from "node:fs";

const DEV_VARS_PATH = ".dev.vars";

// Matches the seed default (scripts/seed-dev-d1.ts) so the mailbox_id the dev server
// derives lines up with the seeded `test@example.com` row. Keep them in sync.
const LOCAL_DEV_VARS = `# Auto-generated minimal local dev config (scripts/ensure-dev-vars.ts).
# Safe to edit or delete — it is only (re)generated when missing, never overwritten.
# See .dev.vars.example for every supported variable and what it does.

# Key order matches .dev.vars.example / the committed types (a local \`pnpm cf-typegen\` stays clean).

# Unlocks the local /api/debug/phase0/* introspection endpoints the smoke scripts use.
PHASE0_DEBUG_TOKEN=dev-phase0-debug-token

# Stable mailbox ID derivation secret. Must match the dev seed default.
MAILBOX_ID_SECRET=dev-mailbox-id-secret-v1

# Access / API-token vars are present-but-EMPTY: this keeps the full key set (so a local
# \`pnpm cf-typegen\` matches the committed types) while leaving the local-dev bypass active
# (it needs both Access vars empty/absent). Fill them in only to test real Access locally.
CLOUDFLARE_API_TOKEN=
ACCESS_JWT_AUDIENCE=
ACCESS_TEAM_DOMAIN=
`;

if (process.env.RECCADO_SKIP_DEV_VARS === "1") {
	console.log("ensure-dev-vars: RECCADO_SKIP_DEV_VARS=1 set, skipping.");
} else if (existsSync(DEV_VARS_PATH)) {
	console.log("ensure-dev-vars: .dev.vars already exists, leaving it untouched.");
} else {
	try {
		// `wx` fails if the file appeared between the existsSync check and here (concurrent predev).
		writeFileSync(DEV_VARS_PATH, LOCAL_DEV_VARS, { encoding: "utf8", flag: "wx" });
		console.log("ensure-dev-vars: wrote a minimal .dev.vars for local development.");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
			console.log("ensure-dev-vars: .dev.vars already exists, leaving it untouched.");
		} else {
			throw error;
		}
	}
}
