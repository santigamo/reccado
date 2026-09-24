/**
 * The wrangler subprocess, as the operator scripts run it.
 *
 * Factored out of `setup-sending.ts` so `pnpm onboard` reads Email Sending and
 * Email Routing through exactly the same invocation: same account auth, same
 * stdio handling, same token stripping.
 */
import { execFileSync } from "node:child_process";

/**
 * wrangler prefers CLOUDFLARE_API_TOKEN over the `wrangler login` OAuth session, but the
 * setup scripts set that token ONLY for their own DNS REST calls (a least-privilege
 * Zone·DNS·Edit token). wrangler's `email sending` / `email routing` / `queues subscription`
 * commands need the operator's full account auth, so strip the token (and the legacy
 * global-key vars) from wrangler's env — it then falls back to the OAuth session, while
 * the scripts' own fetch() DNS calls keep using the token.
 *
 * Node's child_process omits env keys whose value is undefined, so this removes them for
 * the wrangler subprocess without a `delete` (which trips strict-mode TS on the augmented
 * ProcessEnv).
 */
function wranglerEnv(): NodeJS.ProcessEnv {
	const env: Record<string, string | undefined> = { ...process.env };
	env.CLOUDFLARE_API_TOKEN = undefined;
	env.CLOUDFLARE_API_KEY = undefined;
	env.CLOUDFLARE_EMAIL = undefined;
	return env as NodeJS.ProcessEnv;
}

/**
 * Runs `pnpm wrangler <argv>`. With `capture`, stdout is returned; otherwise it is
 * inherited (printed) and the return value is empty. stderr is always piped so a
 * failure's `error.stderr` can be inspected by the caller.
 */
export function wrangler(argv: string[], opts: { capture?: boolean } = {}): string {
	return execFileSync("pnpm", ["wrangler", ...argv], {
		encoding: "utf8",
		stdio: opts.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "pipe"],
		env: wranglerEnv(),
	});
}

/**
 * Runs wrangler for its output and reports failure as a value. `wrangler()`
 * throws, which is right for a mutation the operator asked for; readers instead
 * have to distinguish "not there yet" from "this CLI cannot do it", and both of
 * those are answers, not crashes.
 */
export function wranglerCapture(argv: string[]): { ok: boolean; out: string; err: string } {
	try {
		return { ok: true, out: wrangler(argv, { capture: true }), err: "" };
	} catch (error) {
		const stderr = (error as { stderr?: unknown })?.stderr;
		const stdout = (error as { stdout?: unknown })?.stdout;
		return {
			ok: false,
			out: typeof stdout === "string" ? stdout : "",
			err: typeof stderr === "string" ? stderr : String(error),
		};
	}
}

/** First line of a captured stderr, for one-line reports. */
export function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
}
