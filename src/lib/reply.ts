/**
 * Who a reply goes to, and what it is called — the classic mail-client rules,
 * pure so they are tested once and shared by the reading pane and the keyboard.
 *
 *  - Reply answers the latest message someone else sent: its Reply-To when it
 *    has one, else its sender. A conversation that is only your own mail
 *    follows up with the same people.
 *  - Reply all adds everyone else on that message (its To and Cc), minus every
 *    address of yours (mailboxes and aliases) and minus duplicates.
 *  - The subject gets one "Re:" / "Fwd:", never "Re: Re:".
 */
import type { Message } from "./mail";

export type ReplyMode = "reply" | "reply_all";

type Source = Pick<
	Message,
	"id" | "direction" | "from_addr" | "to_json" | "cc_json" | "subject" | "reply_to_json"
>;

function list(json: string | null | undefined): string[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json) as unknown;
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

function bare(address: string): string {
	const angled = address.match(/<([^>]+)>/);
	return (angled?.[1] ?? address).trim().toLowerCase();
}

/** Addresses in order, lowercased, without duplicates, empties or any in `exclude`. */
function uniq(addresses: readonly string[], exclude: ReadonlySet<string>): string[] {
	const out: string[] = [];
	for (const raw of addresses) {
		const address = bare(raw);
		if (!address || exclude.has(address) || out.includes(address)) continue;
		out.push(address);
	}
	return out;
}

/** The message Reply answers: the newest one someone else sent, else the newest. */
export function replyTarget<T extends Pick<Message, "direction">>(
	messages: readonly T[],
): T | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.direction === "inbound") return m;
	}
	return messages.at(-1);
}

/**
 * To and Cc for a reply to `target`. `own` holds every address of the owner
 * (mailbox addresses and aliases, any case); none of them is ever a recipient,
 * except when there is nobody else to write to.
 */
export function replyRecipients(
	target: Source,
	mode: ReplyMode,
	own: Iterable<string>,
): { to: string[]; cc: string[] } {
	const mine = new Set([...own].map((a) => a.trim().toLowerCase()));
	const replyTo = list(target.reply_to_json);
	const outbound = target.direction === "outbound";
	// Your own last message: write to the same people again.
	const primary = outbound
		? list(target.to_json)
		: replyTo.length > 0
			? replyTo
			: [target.from_addr];
	let to = uniq(primary, mine);
	// A note to yourself (or a sender that is one of your aliases): keep it.
	if (to.length === 0) to = uniq(primary, new Set());
	if (mode === "reply") return { to, cc: [] };
	const others = outbound
		? list(target.cc_json)
		: [
				// When Reply-To redirected the reply, the original sender is still a participant.
				...(replyTo.length > 0 ? [target.from_addr] : []),
				...list(target.to_json),
				...list(target.cc_json),
			];
	const cc = uniq(others, new Set([...mine, ...to]));
	return { to, cc };
}

const REPLY_PREFIX = /^\s*(?:re|aw|sv)\s*(?:\[\d+\])?\s*:\s*/i;
const FORWARD_PREFIX = /^\s*(?:fwd?|wg)\s*:\s*/i;

/** "Re: X" for X, "Re: X" for "Re: re: X", "Re: Fwd: X" for "Fwd: X". */
export function replySubject(subject: string | null | undefined): string {
	let rest = (subject ?? "").trim();
	while (REPLY_PREFIX.test(rest)) rest = rest.replace(REPLY_PREFIX, "");
	return rest ? `Re: ${rest}` : "Re:";
}

/** "Fwd: X" for X, "Fwd: X" for "Fw: Fwd: X". */
export function forwardSubject(subject: string | null | undefined): string {
	let rest = (subject ?? "").trim();
	while (FORWARD_PREFIX.test(rest)) rest = rest.replace(FORWARD_PREFIX, "");
	return rest ? `Fwd: ${rest}` : "Fwd:";
}
