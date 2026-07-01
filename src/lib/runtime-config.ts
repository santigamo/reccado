const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const DEFAULT_TIMEOUT_MS = 5_000;

export type AccessConfigStatus = {
	configured: boolean;
	ok: boolean;
	mode: "local-dev-bypass" | "access-jwt" | "misconfigured";
	reason: string | null;
	missing: string[];
};

export function isLocalRequest(request: Request): boolean {
	return LOCALHOST_HOSTNAMES.has(new URL(request.url).hostname);
}

export function getAccessConfigStatus(env: Env): AccessConfigStatus {
	const missing: string[] = [];
	if (!env.ACCESS_JWT_AUDIENCE?.trim()) {
		missing.push("ACCESS_JWT_AUDIENCE");
	}
	if (!env.ACCESS_TEAM_DOMAIN?.trim()) {
		missing.push("ACCESS_TEAM_DOMAIN");
	}
	if (missing.length === 2) {
		return {
			configured: false,
			ok: true,
			mode: "local-dev-bypass",
			reason: "Cloudflare Access validation is disabled until ACCESS_JWT_AUDIENCE is configured.",
			missing,
		};
	}
	if (missing.length > 0) {
		return {
			configured: false,
			ok: false,
			mode: "misconfigured",
			reason: `Cloudflare Access validation is misconfigured; missing ${missing.join(", ")}.`,
			missing,
		};
	}
	return {
		configured: true,
		ok: true,
		mode: "access-jwt",
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
