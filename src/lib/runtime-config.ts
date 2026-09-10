const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const DEFAULT_TIMEOUT_MS = 5_000;

export type AuthConfigStatus = {
	configured: boolean;
	ok: boolean;
	mode: "better-auth" | "local-dev-bypass" | "misconfigured";
	reason: string | null;
	missing: string[];
};

export function isLocalRequest(request: Request): boolean {
	return LOCALHOST_HOSTNAMES.has(new URL(request.url).hostname);
}

/**
 * Whether the worker can issue and verify web sessions.
 *
 * Three modes, deliberately the same vocabulary everywhere the answer is
 * needed (getAuthContext, /api/health, the doctor):
 *
 *  - no BETTER_AUTH_SECRET  -> "local-dev-bypass": localhost keeps the dev
 *    identity, and every other host must get nothing (getAuthContext returns
 *    null, so 401). Unset is a valid, safe configuration -- that is why ok is
 *    true and the missing list is informational.
 *  - a secret shorter than better-auth's minimum -> "misconfigured": the
 *    operator tried to configure the perimeter and did it wrong, which is the
 *    one case that must fail LOUDLY (ok false, 503) rather than silently
 *    degrade.
 *  - a real secret -> "better-auth": sessions are verified against D1.
 */
export function getAuthConfigStatus(env: Pick<Env, "BETTER_AUTH_SECRET">): AuthConfigStatus {
	const secret = env.BETTER_AUTH_SECRET?.trim();
	if (!secret) {
		return {
			configured: false,
			ok: true,
			mode: "local-dev-bypass",
			reason: "Better Auth is disabled until BETTER_AUTH_SECRET is configured.",
			missing: ["BETTER_AUTH_SECRET"],
		};
	}
	if (secret.length < 32) {
		return {
			configured: false,
			ok: false,
			mode: "misconfigured",
			reason:
				"Auth validation is misconfigured: BETTER_AUTH_SECRET is set but shorter than 32 characters.",
			missing: [],
		};
	}
	return {
		configured: true,
		ok: true,
		mode: "better-auth",
		reason: null,
		missing: [],
	};
}

export async function fetchWithTimeout(
	input: RequestInfo | URL,
	init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
	const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...requestInit } = init;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);
	const abortExternal = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", abortExternal, { once: true });
	try {
		return await fetch(input, {
			...requestInit,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", abortExternal);
	}
}

export function isAbortTimeoutError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return error.name === "AbortError" || error.message === "timeout";
}
