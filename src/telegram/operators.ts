/**
 * Who may drive the bot, and how a Telegram account becomes one of them.
 *
 * The decision is still a human's: nobody is trusted because the machine felt
 * like it. What changed is the encoding. It used to be a personal Telegram user
 * id -- a number no human knows by heart, that nobody can verify by reading it --
 * committed to a repository and changeable only by redeploy. Now the human
 * declares "the account that answers with this code, in the next two hours, is
 * me", and the machine does what machines are good at: observing which id showed
 * up. The declaration is unchanged in kind and far better in form.
 *
 * The bootstrap variable still wins if present, because a deployment that has
 * locked itself out needs a door that does not depend on the database.
 */

import {
	consumePairingCode,
	deleteSpentPairingCodes,
	ensurePairingCode,
	type PairingClaim,
	type PairingCode,
	readOwnerRegistry,
} from "../db/owners";
import { insertOpsEvent } from "../db/d1";

/**
 * Two hours against an hourly cron: long enough that a code is always live while
 * the bridge is unpaired (the whole point -- an operator who checks the table
 * must find something usable there), short enough that a forgotten deployment is
 * not carrying a standing invitation for a week.
 */
const PAIRING_CODE_TTL_MS = 2 * 60 * 60 * 1000;

function bootstrapOperators(env: Env): string[] {
	return (env.TELEGRAM_ALLOWED_USER_IDS ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/**
 * The operator set in force: linked identities plus the emergency variable.
 *
 * Async, unavoidably, because the answer lives in D1 -- which is why
 * readTelegramConfig no longer pretends to know it. The callers that used to get
 * it synchronously (the webhook, the notifier, health) all had an await in reach
 * already.
 */
export async function resolveTelegramOperators(env: Env): Promise<Set<string>> {
	const registry = await readOwnerRegistry(env.INDEX_DB);
	return new Set([...registry.telegramUserIds, ...bootstrapOperators(env)]);
}

export type PairingOutcome = { claim: PairingClaim; userId: string };

/**
 * Spends a code for a Telegram account, and records that it happened.
 *
 * The ops_event is not decoration: this is the one call in the system that turns
 * a stranger into someone who can send mail as the operator, and an escalation
 * nobody can reconstruct afterwards is an escalation nobody can audit. Rejections
 * are recorded too -- a stream of them is somebody guessing.
 */
export async function claimTelegramPairing(
	env: Env,
	input: { code: string; userId: string; chatId: string },
): Promise<PairingOutcome> {
	const claim = await consumePairingCode(env.INDEX_DB, {
		code: input.code,
		kind: "telegram",
		identity: input.userId,
	});
	await insertOpsEvent(env.INDEX_DB, {
		id: crypto.randomUUID(),
		event_type: claim === "linked" ? "owner.telegram_linked" : "owner.pairing_rejected",
		severity: claim === "linked" ? "info" : "warning",
		subject: input.userId,
		// Deliberately no code, not even a prefix: a rejected attempt is evidence of
		// guessing, and writing the guesses down would put live codes in a table
		// read for entirely different reasons.
		payload_json: JSON.stringify({ claim, chatId: input.chatId }),
	}).catch(() => undefined);
	return { claim, userId: input.userId };
}

export type PairingCodeState =
	| { status: "not_needed" }
	| { status: "available"; pairing: PairingCode; minted: boolean }
	| { status: "failed"; error: string };

/**
 * Keeps exactly one pairing code live while the bridge has no operator at all.
 *
 * Minting without being asked deserves justification. While no operator is
 * linked, nobody can drive the bot, so the code grants an authority that is
 * currently held by no one; it is unguessable, single-use, expiring, and readable
 * only by whoever can already read D1 -- who, being able to write D1 with the
 * same credential, could insert an owner row and skip the code entirely. So the
 * marginal risk is nil and the payoff is the thing this whole design needs: a
 * bootstrap path that does not require the authenticated UI, which in this
 * deployment nobody can reach.
 *
 * Never throws. It runs inside the cron sweep, and a database hiccup here must
 * not cost the webhook reconciliation that follows it.
 */
export async function ensureOwnerPairingCode(env: Env): Promise<PairingCodeState> {
	try {
		const operators = await resolveTelegramOperators(env);
		if (operators.size > 0) {
			await deleteSpentPairingCodes(env.INDEX_DB);
			return { status: "not_needed" };
		}
		const { pairing, minted } = await ensurePairingCode(env.INDEX_DB, {
			ttlMs: PAIRING_CODE_TTL_MS,
			issuedBy: "cron",
		});
		if (minted) {
			await insertOpsEvent(env.INDEX_DB, {
				id: crypto.randomUUID(),
				event_type: "owner.pairing_code_minted",
				severity: "info",
				subject: "telegram",
				// The code itself stays in owner_pairing_codes. One home for a live
				// credential is enough.
				payload_json: JSON.stringify({ expiresAt: pairing.expiresAt }),
			}).catch(() => undefined);
		}
		return { status: "available", pairing, minted };
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}
