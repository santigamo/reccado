/**
 * The pure half of the operator session layer (`pnpm operator ...`).
 *
 * Everything here is free of `node:*` imports and subprocesses so it can be
 * unit-tested inside the Workers Vitest pool: host normalization, the SQL that
 * mints and expires a pairing code, Set-Cookie parsing, session-file shape and
 * permission checks, and `operatorFetch` itself (with an injectable fetch).
 *
 * The side-effecting half — wrangler, the filesystem, the login/logout flow —
 * lives in ./operator-session.ts, which re-exports this module. Later scripts
 * should import from there.
 */

/** A control-plane session as persisted on disk. The cookie is a live credential. */
export type OperatorSession = {
	/** Normalized host, e.g. `inbox.example.com` or `localhost:3000`. */
	host: string;
	/** A single `name=value` pair — the Better Auth session-token cookie, nothing else. */
	cookie: string;
	/** ISO-8601 time the session was minted by `login`. */
	createdAt: string;
	/** Sanitized label recorded as the pairing code's `issued_by`. */
	label: string;
	/** Owner email the session belongs to (as confirmed by get-session). */
	email?: string;
	/** Session expiry as reported by the server at login time, when known. */
	expiresAt?: string;
};

/** Directory mode for `~/.config/reccado/sessions`: owner-only. */
export const SESSION_DIR_MODE = 0o700;
/** File mode for a session file: owner read/write only. */
export const SESSION_FILE_MODE = 0o600;

/** Bounds for the pairing code's lifetime. It only has to survive one HTTP round trip. */
export const MIN_TTL_MINUTES = 1;
export const MAX_TTL_MINUTES = 60;
export const DEFAULT_TTL_MINUTES = 10;

/** Minimum pairing-code entropy, in bytes (128 bits). */
export const PAIRING_CODE_BYTES = 16;

export const DEFAULT_LABEL = "operator-cli";

/** Better Auth's session cookie, with or without the `__Secure-` / `__Host-` prefix. */
const SESSION_COOKIE_NAME = /^(?:__Secure-|__Host-)?better-auth\.session_token$/;

/** The command an operator runs to get a session; used in every "not signed in" message. */
export function loginCommandHint(host: string, env?: string): string {
	return `pnpm operator login${env ? ` --env ${env}` : ""} --host ${host}`;
}

/**
 * Thrown by `operatorFetch` when the control plane answers 401: the stored
 * session is missing, expired or revoked. The message tells the operator what
 * to run; callers can `instanceof`-check it to exit cleanly instead of dumping
 * a stack trace.
 */
export class OperatorAuthError extends Error {
	readonly status = 401;
	constructor(
		readonly host: string,
		readonly path: string,
		env?: string,
	) {
		super(`Not signed in to ${host} (401 on ${path}). Run: ${loginCommandHint(host, env)}`);
		this.name = "OperatorAuthError";
	}
}

/** Thrown by `operatorJson` for any non-2xx response other than 401. */
export class OperatorHttpError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		readonly body: string,
	) {
		super(`HTTP ${status} on ${path}: ${body.slice(0, 500)}`);
		this.name = "OperatorHttpError";
	}
}

/** Thrown for bad operator input (host, email, ttl, label) before anything is minted. */
export class OperatorInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OperatorInputError";
	}
}

/**
 * Accepts `inbox.example.com`, `https://inbox.example.com/`, `localhost:3000`
 * and returns the bare lowercased host[:port]. Anything with a path, userinfo
 * or odd characters is rejected: the host becomes a filename and an Origin.
 */
export function normalizeHost(input: string): string {
	let host = input.trim().toLowerCase();
	host = host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
	if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/.test(host) || host.includes("..")) {
		throw new OperatorInputError(
			`Invalid host "${input}". Pass a bare hostname like inbox.example.com.`,
		);
	}
	return host;
}

/** localhost / 127.0.0.1 targets use http and the local D1. */
export function isLocalHost(host: string): boolean {
	const name = host.replace(/:\d+$/, "");
	return name === "localhost" || name === "127.0.0.1";
}

/** The scheme+host the worker sees as its own origin (and the Origin header we send). */
export function originFor(host: string): string {
	return `${isLocalHost(host) ? "http" : "https"}://${host}`;
}

/** Strict enough to be safe inside a SQL literal even before escaping. */
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/;

export function normalizeEmail(input: string): string {
	const email = input.trim().toLowerCase();
	if (!EMAIL_RE.test(email)) {
		throw new OperatorInputError(`Invalid owner email "${input}".`);
	}
	return email;
}

/**
 * Reduces a free-form label to `[A-Za-z0-9._:-]`, at most 48 chars, so it is
 * safe in SQL, logs and `issued_by`. Empty after sanitizing → the default.
 */
export function sanitizeLabel(label: string | undefined): string {
	const cleaned = (label ?? "")
		.replace(/[^A-Za-z0-9._:-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return cleaned || DEFAULT_LABEL;
}

export function assertTtlMinutes(ttl: number): number {
	if (!Number.isInteger(ttl) || ttl < MIN_TTL_MINUTES || ttl > MAX_TTL_MINUTES) {
		throw new OperatorInputError(
			`--ttl must be an integer between ${MIN_TTL_MINUTES} and ${MAX_TTL_MINUTES} minutes.`,
		);
	}
	return ttl;
}

/** Hex, at least 128 bits. The only shape of code this layer ever mints or expires. */
export function assertPairingCode(code: string): string {
	if (!/^[0-9a-f]+$/.test(code) || code.length < PAIRING_CODE_BYTES * 2) {
		throw new OperatorInputError("Pairing code must be lowercase hex of at least 128 bits.");
	}
	return code;
}

/** `issued_by` for codes this CLI mints, so they are distinguishable from 'cron' / 'manual'. */
export function issuedByFor(label: string): string {
	return `cli:${sanitizeLabel(label)}`;
}

/** SQL single-quoted literal. Every value is also pre-validated to a safe charset. */
function sqlLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The INSERT that mints a pairing code.
 *
 * By default the row is only inserted if the email is ALREADY a registered
 * owner (`owner_identities`): the pairing endpoint links any email it is handed
 * as a new owner, so a typo in `--email` would otherwise silently grant owner
 * access to a stranger's address. `allowNewOwner` drops that guard for the
 * genuine bootstrap/rescue case. The caller checks the affected-row count.
 */
export function buildMintSql(input: {
	code: string;
	email: string;
	label: string;
	ttlMinutes: number;
	allowNewOwner?: boolean;
}): string {
	const code = sqlLiteral(assertPairingCode(input.code));
	const email = sqlLiteral(normalizeEmail(input.email));
	const issuedBy = sqlLiteral(issuedByFor(input.label));
	const ttl = assertTtlMinutes(input.ttlMinutes);
	const guard = input.allowNewOwner
		? ""
		: `\nWHERE EXISTS (SELECT 1 FROM owner_identities WHERE kind = 'email' AND identity = ${email})`;
	return (
		"INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by)\n" +
		`SELECT ${code}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+${ttl} minutes'), ${issuedBy}` +
		`${guard};`
	);
}

/** Expires a still-unspent code minted by this CLI (best-effort cleanup after a failure). */
export function buildExpireSql(code: string): string {
	return (
		`UPDATE owner_pairing_codes SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')\n` +
		`WHERE code = ${sqlLiteral(assertPairingCode(code))} AND consumed_at IS NULL;`
	);
}

/**
 * Splits a comma-joined Set-Cookie header (what `Headers.get` returns) into
 * individual cookies, without splitting inside `Expires=Wed, 21 Oct ...`.
 */
export function splitSetCookieHeader(combined: string): string[] {
	return combined
		.split(/,(?=\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=)/)
		.map((part) => part.trim())
		.filter(Boolean);
}

/** All Set-Cookie values on a response, however the runtime exposes them. */
export function setCookieValues(headers: Headers): string[] {
	const getter = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
	if (typeof getter === "function") {
		const values = getter.call(headers);
		if (values.length > 0) return values;
	}
	const combined = headers.get("set-cookie");
	return combined ? splitSetCookieHeader(combined) : [];
}

/**
 * Picks the Better Auth session-token cookie out of a list of Set-Cookie
 * values and returns it as a `name=value` pair ready for a Cookie header.
 * Ignores every other cookie (session_data cache, etc.) and attributes. Returns
 * undefined when absent or when the value is empty (a deletion).
 */
export function parseSessionCookie(setCookies: readonly string[]): string | undefined {
	for (const header of setCookies) {
		const pair = header.split(";", 1)[0]?.trim() ?? "";
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (SESSION_COOKIE_NAME.test(name) && value && value !== '""') {
			return `${name}=${value}`;
		}
	}
	return undefined;
}

/** Filename-safe form of a host (`localhost:3000` → `localhost_3000`). */
export function sessionFileName(host: string): string {
	return `${normalizeHost(host).replace(/:/g, "_")}.json`;
}

/** `<configHome>/reccado/sessions`, where configHome is $XDG_CONFIG_HOME or ~/.config. */
export function sessionDirPath(opts: { home: string; xdgConfigHome?: string }): string {
	const base = opts.xdgConfigHome?.trim() || `${opts.home.replace(/\/+$/, "")}/.config`;
	return `${base.replace(/\/+$/, "")}/reccado/sessions`;
}

export function sessionFilePath(
	host: string,
	opts: { home: string; xdgConfigHome?: string },
): string {
	return `${sessionDirPath(opts)}/${sessionFileName(host)}`;
}

/**
 * Why a session file/dir with this mode must not be trusted, or undefined if it
 * is fine. Any group/other bit on a file holding a live cookie is a leak.
 */
export function insecureModeReason(mode: number, kind: "file" | "dir"): string | undefined {
	const perms = mode & 0o777;
	if ((perms & 0o077) !== 0) {
		const want = kind === "file" ? SESSION_FILE_MODE : SESSION_DIR_MODE;
		return `session ${kind} has mode ${perms.toString(8).padStart(3, "0")}; expected ${want.toString(8)} (owner-only)`;
	}
	return undefined;
}

/** Validates a parsed session file. Throws on anything that is not ours or not for this host. */
export function parseSessionFile(raw: string, expectedHost: string): OperatorSession {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new OperatorInputError("Session file is not valid JSON.");
	}
	const obj = data as Partial<OperatorSession> | null;
	if (
		!obj ||
		typeof obj.host !== "string" ||
		typeof obj.cookie !== "string" ||
		typeof obj.createdAt !== "string" ||
		typeof obj.label !== "string"
	) {
		throw new OperatorInputError("Session file is missing host/cookie/createdAt/label.");
	}
	const host = normalizeHost(expectedHost);
	if (normalizeHost(obj.host) !== host) {
		throw new OperatorInputError(`Session file is for ${obj.host}, not ${host}.`);
	}
	if (!parseSessionCookie([obj.cookie])) {
		throw new OperatorInputError("Session file does not hold a Better Auth session cookie.");
	}
	return {
		host,
		cookie: obj.cookie,
		createdAt: obj.createdAt,
		label: obj.label,
		...(typeof obj.email === "string" ? { email: obj.email } : {}),
		...(typeof obj.expiresAt === "string" ? { expiresAt: obj.expiresAt } : {}),
	};
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Builds the request headers for a control-plane call: the session cookie, an
 * Origin matching the deployment (mutating /api routes enforce it), and a JSON
 * content-type when a body is present and the caller did not set one.
 */
export function operatorHeaders(
	session: Pick<OperatorSession, "host" | "cookie">,
	init: RequestInit = {},
): Headers {
	const headers = new Headers(init.headers);
	headers.set("cookie", session.cookie);
	headers.set("origin", originFor(session.host));
	if (init.body != null && !headers.has("content-type")) {
		headers.set("content-type", "application/json");
	}
	if (!headers.has("accept")) headers.set("accept", "application/json");
	return headers;
}

/**
 * Calls the deployment's control plane as the operator.
 *
 * `path` must be an absolute path on the session's own host (`/api/domains`);
 * full URLs are refused so the cookie can never be sent anywhere else. Returns
 * the Response for any status except 401, which throws OperatorAuthError.
 */
export async function operatorFetch(
	session: Pick<OperatorSession, "host" | "cookie">,
	path: string,
	init: RequestInit = {},
	opts: { fetchImpl?: FetchLike; env?: string } = {},
): Promise<Response> {
	if (!path.startsWith("/") || path.startsWith("//")) {
		throw new OperatorInputError(`operatorFetch path must start with "/": got "${path}".`);
	}
	const fetchImpl = opts.fetchImpl ?? ((input, reqInit) => fetch(input, reqInit));
	const response = await fetchImpl(`${originFor(session.host)}${path}`, {
		...init,
		headers: operatorHeaders(session, init),
		redirect: "manual",
	});
	if (response.status === 401) {
		throw new OperatorAuthError(session.host, path, opts.env);
	}
	return response;
}

/**
 * `operatorFetch` + JSON: serializes a non-string `body`, throws
 * OperatorHttpError on non-2xx, and returns the parsed JSON (or null for 204).
 */
export async function operatorJson<T = unknown>(
	session: Pick<OperatorSession, "host" | "cookie">,
	path: string,
	init: Omit<RequestInit, "body"> & { body?: unknown } = {},
	opts: { fetchImpl?: FetchLike; env?: string } = {},
): Promise<T> {
	const { body, ...rest } = init;
	const requestInit: RequestInit = { ...rest };
	if (body !== undefined) {
		requestInit.body = typeof body === "string" ? body : JSON.stringify(body);
	}
	const response = await operatorFetch(session, path, requestInit, opts);
	const text = await response.text();
	if (!response.ok) {
		throw new OperatorHttpError(response.status, path, text);
	}
	return (text ? JSON.parse(text) : null) as T;
}

/** Replaces every occurrence of each secret with `[redacted]` (for wrangler stderr, errors). */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
	let out = text;
	for (const secret of secrets) {
		if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
	}
	return out;
}

/**
 * Reads the affected-row count from `wrangler d1 execute --json` output
 * (`[{ results, success, meta: { changes } }]`). Tolerates leading non-JSON
 * noise on stdout. Returns undefined if no count is present.
 */
export function parseD1Changes(stdout: string): number | undefined {
	const start = stdout.indexOf("[");
	if (start === -1) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.slice(start));
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	let total: number | undefined;
	for (const entry of parsed) {
		const changes = (entry as { meta?: { changes?: unknown } })?.meta?.changes;
		if (typeof changes === "number") total = (total ?? 0) + changes;
	}
	return total;
}

/** The response shape of POST /api/auth/pairing (mirrors src/api/better-auth.ts). */
export type PairingResult =
	| { ok: true; claim: "linked" | "already_owner" }
	| { ok: false; claim: string };

export function parsePairingResult(body: string): PairingResult | undefined {
	try {
		const parsed = JSON.parse(body) as { ok?: unknown; claim?: unknown };
		if (typeof parsed.ok !== "boolean" || typeof parsed.claim !== "string") return undefined;
		return parsed as PairingResult;
	} catch {
		return undefined;
	}
}

/** What `whoami` reports, from GET /api/auth/get-session (Better Auth returns null when signed out). */
export type SessionInfo = { email: string; expiresAt?: string } | null;

export function parseGetSession(body: string): SessionInfo {
	try {
		const parsed = JSON.parse(body) as {
			user?: { email?: unknown };
			session?: { expiresAt?: unknown };
		} | null;
		const email = parsed?.user?.email;
		if (typeof email !== "string") return null;
		const expiresAt = parsed?.session?.expiresAt;
		return typeof expiresAt === "string" ? { email, expiresAt } : { email };
	} catch {
		return null;
	}
}
