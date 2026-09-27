#!/usr/bin/env tsx
/**
 * `pnpm smoke:telegram` — do new-mail cards land in each mailbox's topic?
 *
 *   pnpm operator login --env dev --host <host>
 *   pnpm smoke:telegram --env dev --host <host> [--mailbox <mailboxId|address>] [--json]
 *
 * Asks the worker (POST /api/telegram/test) to post one clearly labelled test
 * message per active mailbox -- or only --mailbox -- into its topic in the bound
 * chat, through the same send path real cards use, and prints where Telegram
 * says each one landed: delivered_to_topic, fell_back_to_general (Telegram
 * accepted it but filed it under General), delivered_to_chat (no topics), or
 * failed with the reason. Exit code 1 unless every message landed where a card
 * would.
 *
 * Posts real messages into the operator's chat, and nothing else: no topic is
 * created, no mapping changed, and no reply link recorded, so answering a test
 * message in Telegram sends no email. The bot token never leaves the worker.
 */
import type { DeliveryTestResult } from "../src/telegram/admin/delivery-test";
import {
	OperatorHttpError,
	operatorJson,
	requireSession,
	resolveHost,
} from "./lib/operator-session";
import {
	describeApiRefusal,
	formatDeliveryTest,
	resolveMailboxRef,
} from "./lib/telegram-operator-core";

function parseArgs(argv: string[]): Record<string, string> {
	const flags: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg?.startsWith("--")) continue;
		const [key, inline] = arg.slice(2).split("=", 2);
		if (!key) continue;
		const next = argv[i + 1];
		if (inline !== undefined) flags[key] = inline;
		else if (next && !next.startsWith("--")) {
			flags[key] = next;
			i += 1;
		} else flags[key] = "true";
	}
	return flags;
}

async function main(): Promise<number> {
	const flags = parseArgs(process.argv.slice(2));
	if (flags.help) {
		console.log(
			"Usage: pnpm smoke:telegram [--env <env>] [--host <host>] [--mailbox <mailboxId|address>] [--json]",
		);
		return 0;
	}
	const env = flags.env && flags.env !== "true" ? flags.env : undefined;
	const host = resolveHost(flags.host, env);
	const session = requireSession(host, env);

	let mailboxId: string | undefined;
	if (flags.mailbox && flags.mailbox !== "true") {
		const { mailboxes } = await operatorJson<{
			mailboxes: Array<{ mailbox_id: string; primary_address: string }>;
		}>(session, "/api/mailboxes", {}, { env });
		mailboxId = resolveMailboxRef(flags.mailbox, mailboxes);
	}

	let result: DeliveryTestResult;
	try {
		result = await operatorJson<DeliveryTestResult>(
			session,
			"/api/telegram/test",
			{ method: "POST", body: mailboxId ? { mailboxId } : {} },
			{ env },
		);
	} catch (error) {
		if (error instanceof OperatorHttpError) {
			console.error(`smoke:telegram: ${describeApiRefusal(error.status, error.body)}`);
			return 1;
		}
		throw error;
	}
	if (flags.json === "true") console.log(JSON.stringify(result, null, 2));
	else for (const line of formatDeliveryTest(result)) console.log(line);
	return result.ok ? 0 : 1;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(`smoke:telegram: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	},
);
