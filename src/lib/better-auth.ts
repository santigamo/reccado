/**
 * The outbound-mail half of the web issuer.
 *
 * Registration is closed (see api/better-auth.ts), so the volume here is one
 * short code now and then, to an address the owner registry already vouched for.
 * That is exactly what the transactional stream is for — but the transactional
 * path lives inside the mailbox Durable Object (templates, quotas, request
 * logs), and an OTP has none of those needs. What it DOES need is to ride the
 * same EMAIL send_email binding and the same MAIL_FROM_ADDRESS identity as
 * everything else this deployment sends, so receivers see one sender, not two.
 * This module is that reuse: the binding plus the From address, nothing more.
 */

import { DEFAULT_FROM_ADDRESS } from "./sender-identity";

/** The shape createAuth needs. A stub can satisfy it in tests. */
export interface AuthMailSender {
	sendMail(message: { to: string; subject: string; text: string }): Promise<void>;
}

/** Structurally typed so tests can pass any Env-like object (see sender-identity.ts). */
export type AuthMailEnv = {
	EMAIL?: SendEmail;
	MAIL_FROM_ADDRESS?: string;
};

/**
 * The real sender: the EMAIL send_email binding, From MAIL_FROM_ADDRESS.
 *
 * No display name is set on purpose — a bare machine address is the honest
 * rendering for an automated code, and MAIL_FROM_ADDRESS is already a verified
 * Email Sending address the receiver can trust.
 */
export function createAuthMailSender(env: AuthMailEnv): AuthMailSender {
	const from = env.MAIL_FROM_ADDRESS?.trim() || DEFAULT_FROM_ADDRESS;
	return {
		async sendMail(message) {
			const binding = env.EMAIL;
			if (!binding) {
				throw new Error(
					"auth.mail_unavailable: the EMAIL send_email binding is missing, so the sign-in code cannot be delivered.",
				);
			}
			await binding.send({ from, to: message.to, subject: message.subject, text: message.text });
		},
	};
}

/**
 * The password-reset mail. The password path needs a way back in that does not
 * depend on remembering the password: sign-in by OTP proves the address, but
 * better-auth's changePassword still wants the old one, so without this a
 * forgotten password would be a dead end with a live session behind it.
 */
export function renderPasswordResetEmail(url: string): { subject: string; text: string } {
	return {
		subject: "Reset your Reccado password",
		text: [
			"Someone (hopefully you) asked to reset the Reccado password for this address.",
			"",
			url,
			"",
			"The link expires in an hour and can be used once. If you did not request it, ignore this email — nothing else will happen.",
			"Your two-factor code is still required after the reset, so this link alone does not open the account.",
		].join("\n"),
	};
}

export function renderOtpEmail(otp: string): { subject: string; text: string } {
	return {
		subject: "Your Reccado sign-in code",
		text: [
			"Someone (hopefully you) asked to sign in to Reccado with this address.",
			"",
			`Sign-in code: ${otp}`,
			"",
			"The code expires in 5 minutes and can be used once. If you did not request it, ignore this email — nothing else will happen.",
		].join("\n"),
	};
}
