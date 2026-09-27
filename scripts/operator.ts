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
 *   pnpm operator telegram status [--json]       bot, bound chat, rights, topics per mailbox
 *   pnpm operator telegram rebind --chat <id> [--apply]
 *   pnpm operator telegram topic <mailboxId|address> (--name "..." | --adopt <threadId>) [--replace] [--apply]
 *   pnpm operator telegram topics
 *
 * The telegram subcommands call /api/telegram/* with the stored session; the
 * worker makes every Bot API call with its own (write-only) token. Mutating
 * ones are dry-run unless --apply is given.
 *
 * Defaults: --host from $RECCADO_HOST (or the env block's single custom-domain
 * route); --email from the first OWNER_BOOTSTRAP_EMAILS entry when set locally.
 * A localhost host targets the local D1 and http://.
 *
 * Never prints the pairing code or the session cookie.
 */
import type { RebindResult } from "../src/telegram/admin/rebind";
import type { TelegramOperatorStatus } from "../src/telegram/admin/status";
import type { TopicListing, TopicMappingResult } from "../src/telegram/admin/topics";
import {
	getSessionInfo,
	loadSession,
	login,
	logout,
	OperatorHttpError,
	operatorJson,
	requireSession,
	resolveHost,
	resolveOwnerEmail,
	sessionPathFor,
} from "./lib/operator-session";
import {
	describeApiRefusal,
	formatRebind,
	formatTelegramStatus,
	formatTopicListing,
	formatTopicResult,
	parseChatFlag,
	parseTopicCommand,
	resolveMailboxRef,
} from "./lib/telegram-operator-core";

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

const USAGE = `Usage: pnpm operator <login|whoami|logout|telegram> [--env <env>] [--host <host>] [--email <owner>]
  login   mint a single-use pairing code in D1, exchange it for a session, store it (0600)
          flags: --ttl <minutes, 1-60, default 10> --label <text> --allow-new-owner
  whoami  show the signed-in owner and session expiry, or "not signed in"
  logout  sign the session out on the server and delete the local session file
  telegram status [--json]
          the bot (@username), the bound chat and the bot's rights there, the webhook,
          and each active mailbox's topic
  telegram rebind --chat <id|@username> [--apply] [--json]
          move the bridge to another chat (dry run by default: checks the chat and the
          bot's rights with Telegram and prints current -> new; --apply writes it)
  telegram topic <mailboxId|address> (--name "..." | --adopt <threadId> [--name "..."])
                 [--replace] [--apply] [--json]
          map a mailbox to a forum topic in the bound chat: create one under --name, or
          adopt an existing thread; the name is stored with the mapping, independent of
          the mailbox's display name (dry run by default)
  telegram topics [--json]
          list every topic mapping, marking the ones in the bound chat`;

type Flags = Record<string, string>;

/** `pnpm operator telegram <sub>`: thin IO around /api/telegram/*; formatting is in the core. */
async function runTelegram(
	sub: string | undefined,
	positional: string[],
	flags: Flags,
	host: string,
	env: string | undefined,
): Promise<number> {
	const session = requireSession(host, env);
	const json = flags.json === "true";
	const apply = flags.apply === "true";
	switch (sub) {
		case "status": {
			const status = await operatorJson<TelegramOperatorStatus>(
				session,
				"/api/telegram/status",
				{},
				{ env },
			);
			if (json) console.log(JSON.stringify(status, null, 2));
			else for (const line of formatTelegramStatus(status)) console.log(line);
			return status.bridge.ok ? 0 : 1;
		}
		case "rebind": {
			const chatId = parseChatFlag(flags.chat);
			const result = await operatorJson<RebindResult>(
				session,
				"/api/telegram/rebind",
				{ method: "POST", body: { chatId, dryRun: !apply } },
				{ env },
			);
			if (json) console.log(JSON.stringify(result, null, 2));
			else for (const line of formatRebind(result)) console.log(line);
			return 0;
		}
		case "topic": {
			const command = parseTopicCommand(positional[2], flags);
			const { mailboxes } = await operatorJson<{
				mailboxes: Array<{ mailbox_id: string; primary_address: string }>;
			}>(session, "/api/mailboxes", {}, { env });
			const mailboxId = resolveMailboxRef(command.mailboxRef, mailboxes);
			const result = await operatorJson<TopicMappingResult>(
				session,
				"/api/telegram/topics",
				{
					method: "POST",
					body: {
						mailboxId,
						...(command.name !== undefined ? { name: command.name } : {}),
						...(command.adoptThreadId !== undefined
							? { adoptThreadId: command.adoptThreadId }
							: {}),
						...(command.replace ? { replace: true } : {}),
						dryRun: !apply,
					},
				},
				{ env },
			);
			if (json) console.log(JSON.stringify(result, null, 2));
			else for (const line of formatTopicResult(result)) console.log(line);
			return 0;
		}
		case "topics": {
			const listing = await operatorJson<TopicListing>(
				session,
				"/api/telegram/topics",
				{},
				{ env },
			);
			if (json) console.log(JSON.stringify(listing, null, 2));
			else for (const line of formatTopicListing(listing)) console.log(line);
			return 0;
		}
		default:
			console.error(`Unknown telegram subcommand "${sub ?? ""}".\n${USAGE}`);
			return 1;
	}
}

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
		case "telegram":
			try {
				return await runTelegram(positional[1], positional, flags, host, env);
			} catch (error) {
				// A refusal from the route (409 no_chat_bound, bot_not_eligible, ...) is an
				// answer, not a crash: print its message, not a stack or a raw body dump.
				if (error instanceof OperatorHttpError) {
					console.error(`operator telegram: ${describeApiRefusal(error.status, error.body)}`);
					return 1;
				}
				throw error;
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
