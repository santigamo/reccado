/**
 * Gmail-style conversation summaries: who took part in a thread, in order, and
 * how a list row names them ("Rico, me", "To: Noor", "Ana .. Rico, me").
 *
 * Pure and dependency-free (bar the display-name sanitiser) so the mailbox
 * Durable Object, which builds the thread list, and the browser, which builds
 * search rows from thread details, produce the same thing.
 */
import { sanitizeDisplayName } from "./display-name";

/** One person in a conversation, in order of their first message. */
export type ThreadParticipant = {
	address: string;
	/** Sanitised display name, or null to fall back to the address. */
	name: string | null;
	/** True for the mailbox owner (an outbound message's sender). */
	me: boolean;
	/** Has at least one unread message in the conversation. */
	unread: boolean;
};

/** The columns a participant list is built from, one row per message, oldest first. */
export type ParticipantSource = {
	direction: "inbound" | "outbound" | string;
	from_addr: string;
	from_name?: string | null;
	is_read: number;
};

/** More than this and the list row elides the middle. Kept on the wire so the row can say so. */
export const MAX_PARTICIPANTS = 8;

/**
 * Senders of a conversation, oldest first, one entry per address. The owner is a
 * single "me" entry whatever alias they wrote from (a reply from hello@ and one
 * from shop@ are both "me").
 */
export function buildParticipants(messages: readonly ParticipantSource[]): ThreadParticipant[] {
	const out: ThreadParticipant[] = [];
	const keys: string[] = [];
	const index = new Map<string, number>();
	for (const message of messages) {
		const me = message.direction === "outbound";
		const address = (message.from_addr ?? "").trim().toLowerCase();
		const key = me ? "\u0000me" : address;
		const unread = message.is_read === 0;
		const seen = index.get(key);
		if (seen !== undefined) {
			const existing = out[seen]!;
			if (unread) existing.unread = true;
			// The newest usable name wins, as for contacts.
			const name = me ? null : sanitizeDisplayName(message.from_name, address);
			if (name) existing.name = name;
			continue;
		}
		if (out.length >= MAX_PARTICIPANTS) {
			// Keep the most recent sender visible: replace the last slot.
			index.delete(keys[out.length - 1]!);
			keys[out.length - 1] = key;
			out[out.length - 1] = {
				address,
				name: me ? null : sanitizeDisplayName(message.from_name, address),
				me,
				unread,
			};
			index.set(key, out.length - 1);
			continue;
		}
		index.set(key, out.length);
		keys.push(key);
		out.push({
			address,
			name: me ? null : sanitizeDisplayName(message.from_name, address),
			me,
			unread,
		});
	}
	return out;
}

/** "Rico Alvarez" -> "Rico" when there is more than one person; the address local part otherwise. */
function shortName(p: ThreadParticipant, many: boolean): string {
	if (p.me) return "me";
	const full = p.name ?? (p.address.split("@")[0] || p.address);
	if (!many) return full;
	return full.split(/\s+/)[0] || full;
}

/**
 * The sender line of a conversation row, Gmail style:
 *  - one sender: their full name ("Rico Alvarez", or "me");
 *  - several: first names, oldest first ("Rico, me", "Ana, Rico, me");
 *  - more than three: the first, then "..", then the last two ("Ana .. Rico, me").
 * Returns the parts so the caller can bold the unread ones.
 */
export function participantLabel(
	participants: readonly ThreadParticipant[],
): Array<{ text: string; unread: boolean; separator: string }> {
	if (participants.length === 0) return [];
	const many = participants.length > 1;
	const shown =
		participants.length > 3
			? [participants[0]!, null, ...participants.slice(-2)]
			: [...participants];
	const parts: Array<{ text: string; unread: boolean; separator: string }> = [];
	for (let i = 0; i < shown.length; i++) {
		const p = shown[i];
		if (p === null || p === undefined) continue;
		const prev = shown[i - 1];
		const separator = i === 0 ? "" : prev === null ? " .. " : ", ";
		parts.push({ text: shortName(p, many), unread: p.unread, separator });
	}
	return parts;
}

/** Recipients of an outbound-only conversation, as a row names them: "To: Noor, rico". */
export function recipientsLabel(
	addresses: readonly string[],
	names: Record<string, string>,
): string {
	const many = addresses.length > 1;
	const labels = addresses.map((address) => {
		const name = sanitizeDisplayName(names[address.toLowerCase()], address);
		const full = name ?? (address.split("@")[0] || address);
		return many ? full.split(/\s+/)[0] || full : full;
	});
	if (labels.length === 0) return "To: (no recipients)";
	return `To: ${labels.join(", ")}`;
}
