#!/usr/bin/env tsx
/**
 * `pnpm operator` — a control-plane (/api/*) session from the terminal.
 *
 * Replaces the hand-rolled "INSERT a pairing code with wrangler, curl
 * /api/auth/pairing, keep cookies.txt" dance. See scripts/lib/operator-session.ts
 * for the flow and the security notes.
 *
 * Usage:
 *   pnpm operator login  --env dev --host inbox.example.com [--email owner@example.com]
 *                        [--ttl 10] [--label my-task] [--allow-new-owner]
 *   pnpm operator whoami --host inbox.example.com
 *   pnpm operator logout --host inbox.example.com
 *
 * Defaults: --host from $RECCADO_HOST (or the env block's single custom-domain
 * route); --email from the first OWNER_BOOTSTRAP_EMAILS entry when set locally.
 * A localhost host targets the local D1 and http://.
 *
 * Never prints the pairing code or the session cookie.
 */
import {
	getSessionInfo,
	loadSession,
	login,
	logout,
	resolveHost,
	resolveOwnerEmail,
	sessionPathFor,
} from "./lib/operator-session";

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
	const positional: string[] = [];
	const flags: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg) continue;
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
		if (!rawKey) continue;
		if (inlineValue !== undefined) {
			flags[rawKey] = inlineValue;
			continue;
		}
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			flags[rawKey] = "true";
			continue;
		}
		flags[rawKey] = next;
		i += 1;
	}
	return { positional, flags };
}

const USAGE = `Usage: pnpm operator <login|whoami|logout> [--env <env>] [--host <host>] [--email <owner>]
  login   mint a single-use pairing code in D1, exchange it for a session, store it (0600)
          flags: --ttl <minutes, 1-60, default 10> --label <text> --allow-new-owner
  whoami  show the signed-in owner and session expiry, or "not signed in"
  logout  sign the session out on the server and delete the local session file`;

async function main(): Promise<number> {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	const command = positional[0];
	const env = flags.env && flags.env !== "true" ? flags.env : undefined;

	if (!command || command === "help" || flags.help) {
		console.log(USAGE);
		return command ? 0 : 1;
	}

	const host = resolveHost(flags.host, env);

	switch (command) {
		case "login": {
			const email = resolveOwnerEmail(flags.email);
			const ttlMinutes = flags.ttl ? Number(flags.ttl) : undefined;
			console.log(`Signing in to ${host} as ${email}...`);
			const result = await login({
				env,
				host,
				email,
				ttlMinutes,
				label: flags.label,
				allowNewOwner: flags["allow-new-owner"] === "true",
			});
			console.log(`  code minted in: ${result.d1} (single-use, spent)`);
			if (result.claim === "linked") {
				console.log(`  NOTE: ${email} was not an owner before; it is now linked as one.`);
			}
			console.log(`  signed in as:   ${result.session.email}`);
			if (result.session.expiresAt) console.log(`  expires:        ${result.session.expiresAt}`);
			console.log(`  session file:   ${result.path} (0600)`);
			return 0;
		}
		case "whoami": {
			const session = loadSession(host);
			if (!session) {
				console.log(`not signed in to ${host}`);
				return 1;
			}
			const info = await getSessionInfo(session);
			if (!info) {
				console.log(`not signed in to ${host} (stored session is no longer valid)`);
				return 1;
			}
			console.log(`signed in to ${host} as ${info.email}`);
			if (info.expiresAt) console.log(`  expires: ${info.expiresAt}`);
			console.log(`  session file: ${sessionPathFor(host)}`);
			return 0;
		}
		case "logout": {
			const result = await logout(host);
			console.log(`server sign-out: ${result.serverSignOut}`);
			console.log(`session file:    ${result.fileRemoved ? "deleted" : "none"} (${result.path})`);
			return result.serverSignOut.startsWith("failed") ? 1 : 0;
		}
		default:
			console.error(`Unknown command "${command}".\n${USAGE}`);
			return 1;
	}
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		// Typed errors (OperatorAuthError / OperatorInputError) already carry the fix; no stack.
		console.error(`operator: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	},
);
