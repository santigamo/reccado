/**
 * Marker + detection for this instance's own authentication e-mail (sign-in
 * OTP, password reset).
 *
 * Why: the owner's login address may be served by this very instance, so an
 * agent with mailbox read access could read its own sign-in codes and walk
 * around the approval boundary. Auth mail is therefore invisible to MCP
 * regardless of scope. Detection is deliberately fail-closed: a valid marker
 * OR a matching sender is each enough to hide a message.
 */

import { DEFAULT_FROM_ADDRESS } from "./sender-identity";

export const AUTH_MAIL_HEADER = "X-Reccado-Auth";
export const INSTANCE_AUTH_KIND = "instance_auth" as const;

const CONTEXT = "reccado-auth-mail.v1";
const BUCKET_MS = 24 * 60 * 60 * 1000;
const MAX_HEADER_SCAN_BYTES = 64 * 1024;

export type AuthMailSecretEnv = {
	BETTER_AUTH_SECRET?: string;
	MAIL_FROM_ADDRESS?: string;
};

export type AuthMailMeta = {
	/** Envelope/header From of the stored message. */
	from: string | null;
	/** Every address the message was delivered/addressed to. */
	recipients?: string[];
	/** Value of the X-Reccado-Auth header, when the raw MIME carried one. */
	marker?: string | null;
	/** When the message arrived; selects the date bucket(s) to accept. */
	receivedAt?: string | number | Date | null;
};

function normalizeAddress(value: string | null | undefined): string {
	const text = (value ?? "").trim();
	const angle = /<([^<>]+)>/.exec(text);
	return (angle?.[1] ?? text).trim().toLowerCase();
}

async function mac(secret: string, to: string, bucket: number): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const data = new TextEncoder().encode(`${CONTEXT}\0${normalizeAddress(to)}\0${bucket}`);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
	return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function secretOf(env: AuthMailSecretEnv): string | null {
	const secret = env.BETTER_AUTH_SECRET?.trim();
	return secret ? secret : null;
}

/** Header map to attach to an auth mail; empty when no secret is configured. */
export async function authMailHeader(
	env: AuthMailSecretEnv,
	to: string,
): Promise<Record<string, string>> {
	const secret = secretOf(env);
	if (!secret) return {};
	const bucket = Math.floor(Date.now() / BUCKET_MS);
	return { [AUTH_MAIL_HEADER]: `v1.${await mac(secret, to, bucket)}` };
}

/** The From address this instance uses for its authentication mail. */
export function authMailSender(env: AuthMailSecretEnv): string {
	return normalizeAddress(env.MAIL_FROM_ADDRESS?.trim() || DEFAULT_FROM_ADDRESS);
}

/** Sender-only check; all that is available for rows ingested before the marker. */
export function isInstanceAuthSender(env: AuthMailSecretEnv, from: string | null): boolean {
	return normalizeAddress(from) === authMailSender(env) && normalizeAddress(from) !== "";
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function isInstanceAuthMail(
	env: AuthMailSecretEnv,
	meta: AuthMailMeta,
): Promise<boolean> {
	if (isInstanceAuthSender(env, meta.from)) return true;
	const secret = secretOf(env);
	const marker = meta.marker?.trim();
	if (!secret || !marker?.startsWith("v1.")) return false;
	const received = meta.receivedAt ? new Date(meta.receivedAt).getTime() : Date.now();
	const base = Math.floor((Number.isFinite(received) ? received : Date.now()) / BUCKET_MS);
	const presented = marker.slice(3);
	for (const to of meta.recipients ?? []) {
		for (const bucket of [base, base - 1, base + 1]) {
			if (timingSafeEqual(presented, await mac(secret, to, bucket))) return true;
		}
	}
	return false;
}

/** Reads X-Reccado-Auth out of the raw header block of an RFC 822 message. */
export function extractAuthMarker(raw: Uint8Array): string | null {
	const head = new TextDecoder("utf-8", { fatal: false }).decode(
		raw.subarray(0, MAX_HEADER_SCAN_BYTES),
	);
	const end = head.search(/\r?\n\r?\n/);
	const block = (end === -1 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
	for (const line of block.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === AUTH_MAIL_HEADER.toLowerCase())
			return line.slice(colon + 1).trim();
	}
	return null;
}
