import { describe, expect, it } from "vitest";
import {
	DEFAULT_LABEL,
	OperatorAuthError,
	OperatorHttpError,
	OperatorInputError,
	assertPairingCode,
	buildExpireSql,
	buildMintSql,
	insecureModeReason,
	isLocalHost,
	normalizeEmail,
	normalizeHost,
	operatorFetch,
	operatorHeaders,
	operatorJson,
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
	splitSetCookieHeader,
} from "../../scripts/lib/operator-session-core";

const CODE = "0123456789abcdef0123456789abcdef";
const COOKIE = "__Secure-better-auth.session_token=tok.sig%3D";

describe("normalizeHost / originFor", () => {
	it("strips scheme and trailing slash and lowercases", () => {
		expect(normalizeHost("https://Inbox.Example.com/")).toBe("inbox.example.com");
		expect(normalizeHost("localhost:3000")).toBe("localhost:3000");
	});
	it("rejects paths, userinfo and odd characters", () => {
		for (const bad of ["inbox.example.com/api", "user@host", "a b", "", "..", "host;rm"]) {
			expect(() => normalizeHost(bad)).toThrow(OperatorInputError);
		}
	});
	it("uses http only for localhost", () => {
		expect(isLocalHost("localhost:3001")).toBe(true);
		expect(isLocalHost("127.0.0.1")).toBe(true);
		expect(isLocalHost("inbox.example.com")).toBe(false);
		expect(originFor("localhost:3000")).toBe("http://localhost:3000");
		expect(originFor("inbox.example.com")).toBe("https://inbox.example.com");
	});
});

describe("sanitizeLabel", () => {
	it("keeps the safe charset", () => {
		expect(sanitizeLabel("onboard:run-1.a_b")).toBe("onboard:run-1.a_b");
	});
	it("replaces quotes, spaces, semicolons and SQL metacharacters", () => {
		const label = sanitizeLabel("x'); DROP TABLE owner_identities;--");
		expect(label).toMatch(/^[A-Za-z0-9._:-]+$/);
		expect(label).not.toContain("'");
		expect(label).not.toContain(";");
		expect(label).not.toContain(" ");
	});
	it("truncates and falls back to the default", () => {
		expect(sanitizeLabel("a".repeat(200))).toHaveLength(48);
		expect(sanitizeLabel("   ")).toBe(DEFAULT_LABEL);
		expect(sanitizeLabel(undefined)).toBe(DEFAULT_LABEL);
	});
});

describe("normalizeEmail", () => {
	it("lowercases valid emails", () => {
		expect(normalizeEmail(" Owner@Example.COM ")).toBe("owner@example.com");
	});
	it("rejects anything that could break out of a SQL literal", () => {
		for (const bad of ["o'wner@example.com", "owner@example.com' --", "not-an-email", "a@b"]) {
			expect(() => normalizeEmail(bad)).toThrow(OperatorInputError);
		}
	});
});

describe("buildMintSql / buildExpireSql", () => {
	it("guards the insert on an existing owner by default", () => {
		const sql = buildMintSql({
			code: CODE,
			email: "Owner@Example.com",
			label: "t",
			ttlMinutes: 10,
		});
		expect(sql).toContain(
			"INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by)",
		);
		expect(sql).toContain(`'${CODE}'`);
		expect(sql).toContain("'+10 minutes'");
		expect(sql).toContain("'cli:t'");
		expect(sql).toContain(
			"WHERE EXISTS (SELECT 1 FROM owner_identities WHERE kind = 'email' AND identity = 'owner@example.com')",
		);
	});
	it("drops the owner guard only with allowNewOwner", () => {
		const sql = buildMintSql({
			code: CODE,
			email: "new@example.com",
			label: "t",
			ttlMinutes: 5,
			allowNewOwner: true,
		});
		expect(sql).not.toContain("owner_identities");
		expect(sql).not.toContain("new@example.com");
	});
	it("sanitizes the label into issued_by", () => {
		const sql = buildMintSql({
			code: CODE,
			email: "o@example.com",
			label: "a'b c",
			ttlMinutes: 10,
		});
		expect(sql).toContain("'cli:a-b-c'");
	});
	it("rejects a non-hex or short code and an out-of-range ttl", () => {
		expect(() => assertPairingCode("abc")).toThrow(OperatorInputError);
		expect(() => assertPairingCode(`${CODE.slice(0, 31)}'`)).toThrow(OperatorInputError);
		expect(() => assertPairingCode(CODE.toUpperCase())).toThrow(OperatorInputError);
		expect(() =>
			buildMintSql({ code: CODE, email: "o@example.com", label: "t", ttlMinutes: 0 }),
		).toThrow();
		expect(() =>
			buildMintSql({ code: CODE, email: "o@example.com", label: "t", ttlMinutes: 61 }),
		).toThrow();
		expect(() =>
			buildMintSql({ code: CODE, email: "o@example.com", label: "t", ttlMinutes: 1.5 }),
		).toThrow();
	});
	it("expires only an unconsumed code", () => {
		const sql = buildExpireSql(CODE);
		expect(sql).toContain("UPDATE owner_pairing_codes SET expires_at = strftime(");
		expect(sql).toContain(`WHERE code = '${CODE}' AND consumed_at IS NULL`);
		expect(() => buildExpireSql("x' OR 1=1 --")).toThrow(OperatorInputError);
	});
});

describe("session cookie parsing", () => {
	it("finds the __Secure- prefixed session token among several Set-Cookie headers", () => {
		expect(
			parseSessionCookie([
				"__Secure-better-auth.session_data=abc; Max-Age=300; Path=/; HttpOnly; Secure",
				`${COOKIE}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`,
			]),
		).toBe(COOKIE);
	});
	it("accepts the unprefixed name (localhost) and ignores lookalikes", () => {
		expect(parseSessionCookie(["better-auth.session_token=v1; Path=/"])).toBe(
			"better-auth.session_token=v1",
		);
		expect(
			parseSessionCookie(["evil-better-auth.session_token=x", "better-auth.session_token_x=y"]),
		).toBe(undefined);
	});
	it("treats an empty value (a deletion) as no cookie", () => {
		expect(parseSessionCookie(["__Secure-better-auth.session_token=; Max-Age=0"])).toBeUndefined();
	});
	it("splits a comma-joined header without breaking Expires dates", () => {
		const parts = splitSetCookieHeader(
			"a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, __Secure-better-auth.session_token=tok; Path=/",
		);
		expect(parts).toHaveLength(2);
		expect(parts[0]).toContain("Expires=Wed, 21 Oct 2026");
		expect(parseSessionCookie(parts)).toBe("__Secure-better-auth.session_token=tok");
	});
	it("reads multiple Set-Cookie values off a Headers object", () => {
		const headers = new Headers();
		headers.append("set-cookie", "__Secure-better-auth.session_data=x; Path=/");
		headers.append("set-cookie", `${COOKIE}; Path=/`);
		expect(parseSessionCookie(setCookieValues(headers))).toBe(COOKIE);
	});
});

describe("session file path and permissions", () => {
	it("lives under ~/.config/reccado/sessions/<host>.json", () => {
		expect(sessionFilePath("inbox.example.com", { home: "/home/op" })).toBe(
			"/home/op/.config/reccado/sessions/inbox.example.com.json",
		);
		expect(sessionFilePath("https://LocalHost:3000/", { home: "/home/op/" })).toBe(
			"/home/op/.config/reccado/sessions/localhost_3000.json",
		);
		expect(sessionFilePath("h.example.com", { home: "/home/op", xdgConfigHome: "/xdg" })).toBe(
			"/xdg/reccado/sessions/h.example.com.json",
		);
	});
	it("cannot be steered out of the sessions dir by the host", () => {
		expect(() => sessionFilePath("../../etc/passwd", { home: "/home/op" })).toThrow(
			OperatorInputError,
		);
	});
	it("flags any group/other permission bit", () => {
		expect(insecureModeReason(0o100600, "file")).toBeUndefined();
		expect(insecureModeReason(0o40700, "dir")).toBeUndefined();
		expect(insecureModeReason(0o100644, "file")).toMatch(/644.*600/);
		expect(insecureModeReason(0o100640, "file")).toBeDefined();
		expect(insecureModeReason(0o40755, "dir")).toMatch(/755.*700/);
	});
	it("validates the stored session and its host", () => {
		const raw = JSON.stringify({
			host: "inbox.example.com",
			cookie: COOKIE,
			createdAt: "2026-01-01T00:00:00.000Z",
			label: "t",
			email: "o@example.com",
		});
		expect(parseSessionFile(raw, "inbox.example.com")).toMatchObject({
			cookie: COOKIE,
			email: "o@example.com",
		});
		expect(() => parseSessionFile(raw, "other.example.com")).toThrow(/not other.example.com/);
		expect(() => parseSessionFile("{", "inbox.example.com")).toThrow(OperatorInputError);
		expect(() =>
			parseSessionFile(
				JSON.stringify({ ...JSON.parse(raw), cookie: "foo=bar" }),
				"inbox.example.com",
			),
		).toThrow(/session cookie/);
	});
});

describe("operatorFetch", () => {
	const session = { host: "inbox.example.com", cookie: COOKIE };

	it("sends cookie, Origin and JSON content-type only when a body is present", async () => {
		const seen: Array<{ url: string; headers: Headers; redirect?: RequestRedirect }> = [];
		const fetchImpl = async (url: string, init?: RequestInit) => {
			seen.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
			return new Response("{}", { status: 200 });
		};
		await operatorFetch(session, "/api/domains", {}, { fetchImpl });
		await operatorFetch(session, "/api/domains", { method: "POST", body: "{}" }, { fetchImpl });
		expect(seen[0]?.url).toBe("https://inbox.example.com/api/domains");
		expect(seen[0]?.headers.get("cookie")).toBe(COOKIE);
		expect(seen[0]?.headers.get("origin")).toBe("https://inbox.example.com");
		expect(seen[0]?.headers.get("content-type")).toBeNull();
		expect(seen[0]?.redirect).toBe("manual");
		expect(seen[1]?.headers.get("content-type")).toBe("application/json");
	});

	it("keeps a caller-provided content-type", () => {
		const headers = operatorHeaders(session, {
			body: "x",
			headers: { "content-type": "text/plain" },
		});
		expect(headers.get("content-type")).toBe("text/plain");
	});

	it("maps 401 to a typed error that names the login command", async () => {
		const fetchImpl = async () => new Response('{"error":"unauthorized"}', { status: 401 });
		const error = await operatorFetch(session, "/api/domains", {}, { fetchImpl, env: "dev" }).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(OperatorAuthError);
		expect((error as OperatorAuthError).status).toBe(401);
		expect((error as Error).message).toContain(
			"pnpm operator login --env dev --host inbox.example.com",
		);
		expect((error as Error).message).not.toContain("tok.sig");
	});

	it("refuses absolute or protocol-relative URLs so the cookie stays on its host", async () => {
		const fetchImpl = async () => new Response("{}");
		await expect(
			operatorFetch(session, "https://evil.example/x", {}, { fetchImpl }),
		).rejects.toThrow(OperatorInputError);
		await expect(operatorFetch(session, "//evil.example/x", {}, { fetchImpl })).rejects.toThrow(
			OperatorInputError,
		);
	});

	it("operatorJson serializes bodies, parses JSON and throws on non-2xx", async () => {
		let sentBody: unknown;
		const ok = async (_url: string, init?: RequestInit) => {
			sentBody = init?.body;
			return new Response('{"domains":[{"domain":"a.example"}]}', { status: 200 });
		};
		await expect(
			operatorJson(session, "/api/domains", { method: "POST", body: { a: 1 } }, { fetchImpl: ok }),
		).resolves.toEqual({
			domains: [{ domain: "a.example" }],
		});
		expect(sentBody).toBe('{"a":1}');
		const bad = async () => new Response("nope", { status: 403 });
		await expect(
			operatorJson(session, "/api/domains", {}, { fetchImpl: bad }),
		).rejects.toBeInstanceOf(OperatorHttpError);
	});
});

describe("response parsing helpers", () => {
	it("reads affected rows from wrangler --json output, tolerating noise", () => {
		expect(parseD1Changes('[{"results":[],"success":true,"meta":{"changes":1}}]')).toBe(1);
		expect(parseD1Changes('noise\n[{"results":[],"success":true,"meta":{"changes":0}}]')).toBe(0);
		expect(parseD1Changes("not json")).toBeUndefined();
		expect(parseD1Changes('[{"results":[]}]')).toBeUndefined();
	});
	it("parses the pairing response", () => {
		expect(parsePairingResult('{"ok":true,"claim":"already_owner"}')).toEqual({
			ok: true,
			claim: "already_owner",
		});
		expect(parsePairingResult('{"ok":false,"claim":"expired"}')).toEqual({
			ok: false,
			claim: "expired",
		});
		expect(parsePairingResult("<html>")).toBeUndefined();
	});
	it("parses get-session, including the signed-out null", () => {
		expect(
			parseGetSession(
				'{"user":{"email":"o@example.com"},"session":{"expiresAt":"2026-10-01T00:00:00.000Z"}}',
			),
		).toEqual({ email: "o@example.com", expiresAt: "2026-10-01T00:00:00.000Z" });
		expect(parseGetSession("null")).toBeNull();
		expect(parseGetSession("")).toBeNull();
	});
	it("redacts secrets from text", () => {
		expect(redact(`failed with ${CODE} and ${COOKIE}`, [CODE, COOKIE])).toBe(
			"failed with [redacted] and [redacted]",
		);
	});
});
