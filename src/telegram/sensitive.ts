/**
 * Which mail the bridge must not publish, and what of it may still be shown.
 *
 * A Telegram chat is a cloud chat, not an end-to-end encrypted one, and the bot
 * repeats whatever it is given on a phone lock screen. One-time codes, reset and
 * magic links are exactly the mail an attacker who reads that chat would want,
 * so every surface that prints an email -- the card, a search hit, a digest line,
 * /unread, "Leer completo", the attachments button -- asks here first.
 *
 * The verdict comes from the mailbox Durable Object, which classified the message
 * at ingest (messages.sensitive_kind, the same column that gates MCP's
 * `mail:read:sensitive`). Three layers on top of it:
 *
 * - This instance's own sign-in and reset mail is hidden however it is
 *   recognised: the stored `instance_auth` kind (HMAC marker checked at ingest),
 *   the instance's auth sender, or the exact subject of its own templates. Any
 *   one is enough, so a classifier miss cannot publish a Reccado sign-in code.
 * - A row the DO never classified (legacy, or classification threw) is classified
 *   now from its stored text; with no text to judge by (HTML only, failed parse)
 *   it is treated as sensitive, as MCP search does.
 * - When the DO cannot be read at all, the same classifier runs on what D1 holds
 *   (subject + snippet). That is the fail-closed choice that stays cheap: the
 *   snippet is exactly the text the card would print, so whatever it would leak is
 *   what gets judged, and an ordinary card is not blanked by a DO blip.
 */

import { isInstanceAuthSender } from "../lib/auth-mail";
import { renderOtpEmail, renderPasswordResetEmail } from "../lib/better-auth";
import {
	classifySensitive,
	redactSensitive,
	type SensitiveKind,
	type StoredSensitiveKind,
} from "../lib/sensitive-mail";
import { inspectMailboxMessage } from "./messages";

/** What the DO answers about one message, as far as sensitivity is concerned. */
export type SensitivityFacts = {
	sensitive_kind?: StoredSensitiveKind | null;
	sensitive_classified?: number | null;
	parse_status?: string | null;
	body_text?: string | null;
	body_html_r2_key?: string | null;
};

/** The subjects of this instance's own auth mail, from the templates that write them. */
const INSTANCE_AUTH_SUBJECTS = new Set(
	[renderOtpEmail("").subject, renderPasswordResetEmail("").subject].map((subject) =>
		subject.trim().toLowerCase(),
	),
);

export function isInstanceAuthSubject(subject: string | null | undefined): boolean {
	return INSTANCE_AUTH_SUBJECTS.has((subject ?? "").trim().toLowerCase());
}

/**
 * The sensitivity of one email for Telegram, or null when it may be shown.
 *
 * `message` is the DO's row (null when the DO could not be read); `fromAddr`,
 * `subject` and `snippet` are what the bridge already holds from D1 or the queue.
 */
export function telegramSensitivity(
	env: Pick<Env, "MAIL_FROM_ADDRESS" | "BETTER_AUTH_SECRET">,
	input: {
		fromAddr: string;
		subject: string | null;
		snippet: string | null;
		message: SensitivityFacts | null;
	},
): SensitiveKind | null {
	try {
		if (
			input.message?.sensitive_kind === "instance_auth" ||
			isInstanceAuthSender(env, input.fromAddr) ||
			isInstanceAuthSubject(input.subject)
		) {
			return "otp";
		}
		const message = input.message;
		if (message) {
			if (message.parse_status === "failed") return "otp";
			if (message.sensitive_classified === 1) {
				return (message.sensitive_kind as SensitiveKind | null | undefined) ?? null;
			}
			if (!message.body_text && message.body_html_r2_key) return "otp";
			return classifySensitive({
				from: input.fromAddr,
				subject: input.subject,
				text: message.body_text ?? input.snippet,
			}).kind;
		}
		return classifySensitive({ from: input.fromAddr, subject: input.subject, text: input.snippet })
			.kind;
	} catch {
		// The classifier is regexes over strings; if it ever throws, the safe answer
		// is the one that prints less.
		return "otp";
	}
}

/**
 * A subject that is safe to print for a sensitive email.
 *
 * Subjects carry codes too ("Your code is 123456"), so every code-shaped token the
 * shared redactor knows is masked, and then any remaining run of four or more
 * digits -- a sensitive mail has no digit run worth reading in a chat.
 */
export function maskSensitiveSubject(subject: string | null, kind: SensitiveKind): string | null {
	if (!subject) return subject;
	return redactSensitive(subject, kind).text.replace(/\d[\d -]{2,}\d/g, (run) =>
		run.replace(/\D/g, "").length >= 4 ? "••••••" : run,
	);
}

/** The sensitivity of an indexed email, asking its Durable Object (one round trip). */
export async function sensitivityOfIndexedMail(
	env: Env,
	row: {
		mailbox_id: string;
		message_local_id: string;
		from_addr: string;
		subject: string | null;
		snippet: string | null;
	},
): Promise<SensitiveKind | null> {
	const message = await inspectMailboxMessage(env, row.mailbox_id, row.message_local_id);
	return telegramSensitivity(env, {
		fromAddr: row.from_addr,
		subject: row.subject,
		snippet: row.snippet,
		message,
	});
}

/** The subject as any Telegram surface may print it. */
export function safeSubject(subject: string | null, kind: SensitiveKind | null): string | null {
	return kind ? maskSensitiveSubject(subject, kind) : subject;
}

/** The line a sensitive card prints where the excerpt would be. */
export const SENSITIVE_PLACEHOLDER = "🔒 Contenido sensible oculto — ábrelo en la web.";

/** What "Leer completo" and "Adjuntos" answer for a sensitive email. */
export const SENSITIVE_REFUSAL = "Correo sensible: no lo muestro en Telegram. Ábrelo en la web.";
