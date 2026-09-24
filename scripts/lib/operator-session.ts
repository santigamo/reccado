/**
 * Operator session layer: an authenticated control-plane (`/api/*`) session
 * from the terminal, without a browser.
 *
 * It automates the pairing-code rescue rung (src/api/better-auth.ts,
 * `handlePairingRequest`): mint a short-lived single-use code straight into D1
 * with `wrangler d1 execute`, spend it at POST /api/auth/pairing, keep the
 * Better Auth session cookie that comes back, and persist it owner-only under
 * `~/.config/reccado/sessions/<host>.json`. Whoever can write this deployment's
 * D1 is already all-powerful over it, so this grants nothing new; it only
 * replaces hand-typed SQL + curl.
 *
 * Public API (for `pnpm operator` and later scripts — onboard, smoke tests):
 *
 *   const { session } = await login({ env: "dev", host, email });
 *   const session = loadSession(host);            // undefined when signed out
 *   await operatorJson(session, "/api/domains");  // throws OperatorAuthError on 401
 *   await logout(host);
 *
 * Nothing here prints the pairing code or the cookie. Pure helpers live in
 * ./operator-session-core.ts and are re-exported.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import {
	DEFAULT_LABEL,
	DEFAULT_TTL_MINUTES,
	type FetchLike,
	type OperatorSession,
	OperatorInputError,
	PAIRING_CODE_BYTES,
	SESSION_DIR_MODE,
	SESSION_FILE_MODE,
	type SessionInfo,
	assertTtlMinutes,
	buildExpireSql,
	buildMintSql,
	insecureModeReason,
	isLocalHost,
	loginCommandHint,
	normalizeEmail,
	normalizeHost,
	operatorFetch,
	originFor,
	parseD1Changes,
	parseGetSession,
	parsePairingResult,
	parseSessionCookie,
	parseSessionFile,
	redact,
	sanitizeLabel,
	sessionFilePath,
	setCookieValues,
} from "./operator-session-core";

export * from "./operator-session-core";

type WranglerBlock = {
	d1_databases?: Array<{ binding: string; database_name: string }>;
	routes?: Array<string | { pattern: string; custom_domain?: boolean }>;
};
type WranglerConfig = WranglerBlock & { env?: Record<string, WranglerBlock> };

function stripJsonc(input: string): string {
	return input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The wrangler config the other operator scripts use: the gitignored
 * `wrangler.generated.<env>.json` written by setup:cloud when present, else
 * `wrangler.jsonc` (same rule as scripts/setup-mailbox.ts).
 */
export function resolveWranglerConfig(env: string | undefined, cwd = process.cwd()) {
	const generated = `wrangler.generated.${env ?? "production"}.json`;
	const path = existsSync(`${cwd}/${generated}`) ? generated : "wrangler.jsonc";
	const config = JSON.parse(stripJsonc(readFileSync(`${cwd}/${path}`, "utf8"))) as WranglerConfig;
	const block = env ? config.env?.[env] : config;
	if (env && !block) {
		throw new OperatorInputError(`No env "${env}" in ${path}.`);
	}
	return { path, block: block ?? {} };
}

/** How to reach INDEX_DB with `wrangler d1 execute` for this target. */
export type D1Target = { args: string[]; label: string };

export function resolveD1Target(opts: { env?: string; local: boolean; cwd?: string }): D1Target {
	if (opts.local) {
		return { args: ["d1", "execute", "INDEX_DB", "--local"], label: "local D1 (INDEX_DB)" };
	}
	const { path, block } = resolveWranglerConfig(opts.env, opts.cwd);
	const name = block.d1_databases?.find((d) => d.binding === "INDEX_DB")?.database_name;
	if (!name) {
		throw new OperatorInputError(
			`Could not resolve the INDEX_DB database name for env "${opts.env ?? "production"}" from ${path}.`,
		);
	}
	return {
		args: [
			"d1",
			"execute",
			name,
			"--remote",
			...(path === "wrangler.jsonc" ? [] : ["--config", path]),
			...(opts.env ? ["--env", opts.env] : []),
		],
		label: `remote D1 "${name}"${opts.env ? ` (env ${opts.env})` : ""}`,
	};
}

/** Host: explicit flag > $RECCADO_HOST > the env block's single custom-domain route. */
export function resolveHost(flag: string | undefined, env: string | undefined): string {
	const explicit = flag?.trim() || process.env.RECCADO_HOST?.trim();
	if (explicit) return normalizeHost(explicit);
	try {
		const { block } = resolveWranglerConfig(env);
		const custom = (block.routes ?? []).flatMap((r) =>
			typeof r === "object" && r.custom_domain ? [r.pattern] : [],
		);
		if (custom.length === 1 && custom[0]) return normalizeHost(custom[0]);
	} catch {
		// Fall through to the error below.
	}
	throw new OperatorInputError("No host. Pass --host <deployment hostname> or set RECCADO_HOST.");
}

/** Reads one key out of a dotenv-style file (same convention as setup-mailbox). */
function readDotEnvValue(path: string, key: string): string | undefined {
	if (!existsSync(path)) return undefined;
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const sep = trimmed.indexOf("=");
		if (sep !== -1 && trimmed.slice(0, sep).trim() === key) return trimmed.slice(sep + 1).trim();
	}
	return undefined;
}

/** Email: explicit flag > first entry of OWNER_BOOTSTRAP_EMAILS (process env, then .dev.vars). */
export function resolveOwnerEmail(flag: string | undefined): string {
	if (flag?.trim()) return normalizeEmail(flag);
	const list =
		process.env.OWNER_BOOTSTRAP_EMAILS || readDotEnvValue(".dev.vars", "OWNER_BOOTSTRAP_EMAILS");
	const first = list
		?.split(",")
		.map((e) => e.trim())
		.find(Boolean);
	if (first) return normalizeEmail(first);
	throw new OperatorInputError(
		"No owner email. Pass --email <owner email> (OWNER_BOOTSTRAP_EMAILS is not set locally).",
	);
}

export function sessionPathFor(host: string): string {
	return sessionFilePath(host, { home: homedir(), xdgConfigHome: process.env.XDG_CONFIG_HOME });
}

/**
 * Runs `wrangler d1 execute ... --command=<sql> --json` with stdout AND stderr
 * captured, so nothing wrangler echoes reaches the terminal. Errors are
 * re-thrown with `secrets` redacted.
 *
 * TRADEOFF: the pairing code travels in this child's argv (`--command=`), so it
 * is visible to same-user `ps` for the second or two wrangler runs. `--file`
 * would avoid that, but for --remote it goes through D1's import path instead
 * of a plain query and does not report affected rows, which the owner guard
 * relies on. Accepted because the code is single-use, expires in minutes, is
 * spent (or force-expired) within the same command, and anyone who can read
 * this user's process table can already read wrangler's own OAuth token.
 */
function runD1(target: D1Target, sql: string, secrets: string[]): string {
	try {
		return execFileSync("pnpm", ["wrangler", ...target.args, `--command=${sql}`, "--json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		const e = error as { stderr?: string; stdout?: string; message?: string };
		const detail = redact(
			`${e.stderr ?? ""}\n${e.stdout ?? ""}`.trim() || String(e.message),
			secrets,
		);
		throw new Error(`wrangler d1 execute failed on ${target.label}:\n${detail}`);
	}
}

/** Writes the session file owner-only: 0700 dir, 0600 file, atomic rename. */
export function writeSessionFile(path: string, session: OperatorSession): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: SESSION_DIR_MODE });
	// mkdir's mode is ignored for a directory that already exists; enforce it.
	chmodSync(dir, SESSION_DIR_MODE);
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`, {
		mode: SESSION_FILE_MODE,
		flag: "wx",
	});
	chmodSync(tmp, SESSION_FILE_MODE);
	renameSync(tmp, path);
}

/**
 * The stored session for `host`, or undefined if there is none. Refuses (throws)
 * a symlinked or group/world-accessible file rather than using a cookie that may
 * have leaked.
 */
export function loadSession(host: string): OperatorSession | undefined {
	const normalized = normalizeHost(host);
	const path = sessionPathFor(normalized);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		return undefined;
	}
	if (!stat.isFile()) {
		throw new OperatorInputError(`${path} is not a regular file; refusing to read it.`);
	}
	const reason = insecureModeReason(stat.mode, "file");
	if (reason) {
		throw new OperatorInputError(
			`${path}: ${reason}. Delete it and run ${loginCommandHint(normalized)}.`,
		);
	}
	return parseSessionFile(readFileSync(path, "utf8"), normalized);
}

/** Loads the session or throws the same "run login" error a 401 would. */
export function requireSession(host: string, env?: string): OperatorSession {
	const session = loadSession(host);
	if (!session) {
		throw new OperatorInputError(
			`Not signed in to ${normalizeHost(host)}. Run: ${loginCommandHint(normalizeHost(host), env)}`,
		);
	}
	return session;
}

export type LoginOptions = {
	/** Wrangler env (`dev`) whose INDEX_DB receives the code. Omit for the top-level config. */
	env?: string;
	host: string;
	email: string;
	ttlMinutes?: number;
	/** Free-form; sanitized to [A-Za-z0-9._:-] and recorded as issued_by `cli:<label>`. */
	label?: string;
	/**
	 * Allow an email that is not yet in owner_identities. Spending a pairing code
	 * LINKS the email as a new owner, so this is off by default.
	 */
	allowNewOwner?: boolean;
	fetchImpl?: FetchLike;
};

export type LoginResult = {
	session: OperatorSession;
	/** "already_owner" normally; "linked" if allowNewOwner registered a new owner. */
	claim: "linked" | "already_owner";
	path: string;
	d1: string;
};

/**
 * Mints a pairing code into D1, spends it for a session, verifies the session
 * belongs to `email`, and persists it. On any failure after minting, the code
 * is force-expired (best effort) so an unused code does not linger.
 */
export async function login(opts: LoginOptions): Promise<LoginResult> {
	const host = normalizeHost(opts.host);
	const email = normalizeEmail(opts.email);
	const ttlMinutes = assertTtlMinutes(opts.ttlMinutes ?? DEFAULT_TTL_MINUTES);
	const label = sanitizeLabel(opts.label ?? DEFAULT_LABEL);
	const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
	const target = resolveD1Target({ env: opts.env, local: isLocalHost(host) });

	// 256 bits; the floor the core validator enforces is 128.
	const code = randomBytes(PAIRING_CODE_BYTES * 2).toString("hex");
	const secrets = [code];

	let minted: number | undefined;
	try {
		minted = parseD1Changes(
			runD1(
				target,
				buildMintSql({ code, email, label, ttlMinutes, allowNewOwner: opts.allowNewOwner }),
				secrets,
			),
		);
	} catch (error) {
		// The insert may or may not have landed; expiring a row that is not there is a no-op.
		try {
			runD1(target, buildExpireSql(code), secrets);
		} catch {
			// Reported by the original error; the code still dies on its own TTL.
		}
		throw error;
	}
	if (minted === 0) {
		throw new OperatorInputError(
			`${email} is not a registered owner in ${target.label}, so no code was minted. ` +
				"Check --email, or pass --allow-new-owner to link it as a NEW owner (rescue/bootstrap only).",
		);
	}

	let cookie: string | undefined;
	try {
		const origin = originFor(host);
		const response = await fetchImpl(`${origin}/api/auth/pairing`, {
			method: "POST",
			headers: { origin, "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ email, code }),
			redirect: "manual",
		});
		const body = await response.text();
		const result = parsePairingResult(body);
		if (!response.ok || !result?.ok) {
			throw new Error(
				`Pairing rejected by ${host}: HTTP ${response.status}, claim=${result?.claim ?? "unparseable"}` +
					(result ? "" : ` body=${redact(body.slice(0, 200), secrets)}`),
			);
		}
		cookie = parseSessionCookie(setCookieValues(response.headers));
		if (!cookie) {
			throw new Error(`Pairing succeeded on ${host} but no Better Auth session cookie was set.`);
		}
		secrets.push(cookie);

		const info = await getSessionInfo({ host, cookie }, fetchImpl);
		if (!info || info.email.toLowerCase() !== email) {
			throw new Error(
				`Session check failed: get-session reported ${info ? info.email : "no session"}, expected ${email}.`,
			);
		}

		const session: OperatorSession = {
			host,
			cookie,
			createdAt: new Date().toISOString(),
			label,
			email: info.email,
			...(info.expiresAt ? { expiresAt: info.expiresAt } : {}),
		};
		const path = sessionPathFor(host);
		writeSessionFile(path, session);
		return { session, claim: result.claim, path, d1: target.label };
	} catch (error) {
		const cleanup: string[] = [];
		// A code the server never spent must not stay valid for the rest of its TTL.
		try {
			runD1(target, buildExpireSql(code), secrets);
			cleanup.push("pairing code expired");
		} catch {
			cleanup.push("could NOT expire the pairing code (it still expires on its own TTL)");
		}
		// A session we created but will not keep should not stay live either.
		if (cookie) {
			try {
				await operatorFetch(
					{ host, cookie },
					"/api/auth/sign-out",
					{ method: "POST", body: "{}" },
					{ fetchImpl },
				);
				cleanup.push("session signed out");
			} catch {
				cleanup.push("could NOT sign the session out");
			}
		}
		const message = redact(error instanceof Error ? error.message : String(error), secrets);
		throw new Error(`${message} (cleanup: ${cleanup.join("; ")})`);
	}
}

/** GET /api/auth/get-session. Better Auth answers 200 `null` when signed out. */
export async function getSessionInfo(
	session: Pick<OperatorSession, "host" | "cookie">,
	fetchImpl?: FetchLike,
): Promise<SessionInfo> {
	try {
		const response = await operatorFetch(session, "/api/auth/get-session", {}, { fetchImpl });
		if (!response.ok) return null;
		return parseGetSession(await response.text());
	} catch (error) {
		if ((error as { status?: number }).status === 401) return null;
		throw error;
	}
}

export type LogoutResult = {
	/** "ok", "no session", or "failed: <reason>". */
	serverSignOut: string;
	fileRemoved: boolean;
	path: string;
};

/**
 * Signs the session out on the server, then deletes the local file even if the
 * server call failed, and reports both outcomes.
 */
export async function logout(
	host: string,
	opts: { fetchImpl?: FetchLike } = {},
): Promise<LogoutResult> {
	const normalized = normalizeHost(host);
	const path = sessionPathFor(normalized);
	let session: OperatorSession | undefined;
	let serverSignOut = "no session";
	try {
		session = loadSession(normalized);
	} catch (error) {
		serverSignOut = `failed: ${(error as Error).message}`;
	}
	if (session) {
		try {
			const response = await operatorFetch(
				session,
				"/api/auth/sign-out",
				{ method: "POST", body: "{}" },
				{ fetchImpl: opts.fetchImpl },
			);
			serverSignOut = response.ok ? "ok" : `failed: HTTP ${response.status}`;
		} catch (error) {
			serverSignOut = `failed: ${redact((error as Error).message, [session.cookie])}`;
		}
	}
	let fileRemoved = false;
	if (lstatExists(path)) {
		rmSync(path, { force: true });
		fileRemoved = !lstatExists(path);
	}
	return { serverSignOut, fileRemoved, path };
}

function lstatExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}
