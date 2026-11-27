import { afterEach, describe, expect, it, vi } from "vitest";
import { templateContentHash } from "#/lib/template-hash";
import {
	MAX_SOURCE_BYTES,
	SourceRefusal,
	checkSourceUrl,
	fetchTemplateSource,
} from "../../src/mcp/template-source";

const OWN = "reccado.example.com";
const sha = async (text: string) =>
	Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");

function refusal(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		return error instanceof SourceRefusal ? error.code : `other:${String(error)}`;
	}
	return "accepted";
}

describe("templateContentHash", () => {
	it("is SHA-256 of the compact JSON array [subject, body_text, body_html] (reproducible in Python)", async () => {
		// python3: json.dumps(["Hola ñ", None, "<p>x</p>"], separators=(",", ":"), ensure_ascii=False)
		expect(await templateContentHash({ subject: "Hola ñ", body_html: "<p>x</p>" })).toBe(
			"2a917821b09567520f9126384984fb2c4282b95176aef5577394fbd0715eb828",
		);
		expect(await templateContentHash({ subject: "a", body_text: null })).toBe(
			await templateContentHash({ subject: "a" }),
		);
		expect(await templateContentHash({ subject: "a", body_text: "" })).not.toBe(
			await templateContentHash({ subject: "a" }),
		);
	});
});

describe("checkSourceUrl", () => {
	it("accepts a public https URL and refuses everything else", () => {
		expect(
			refusal(() => checkSourceUrl("https://gist.githubusercontent.com/u/x/raw/t.json", OWN)),
		).toBe("accepted");
		const cases: Array<[string, string]> = [
			["not a url", "source_url_invalid"],
			["http://example.com/t.json", "source_url_not_https"],
			["ftp://example.com/t.json", "source_url_not_https"],
			["file:///etc/passwd", "source_url_not_https"],
			["https://user:pass@example.com/t.json", "source_url_has_credentials"],
			["https://example.com:8443/t.json", "source_url_port_refused"],
			["https://127.0.0.1/t.json", "source_url_host_refused"],
			["https://2130706433/t.json", "source_url_host_refused"],
			["https://0x7f.1/t.json", "source_url_host_refused"],
			["https://[::1]/t.json", "source_url_host_refused"],
			["https://169.254.169.254/latest", "source_url_host_refused"],
			["https://localhost/t.json", "source_url_host_refused"],
			["https://intranet/t.json", "source_url_host_refused"],
			["https://printer.local/t.json", "source_url_host_refused"],
			["https://db.internal/t.json", "source_url_host_refused"],
			[`https://${OWN}/api/whatever`, "source_url_host_refused"],
			[`https://sub.${OWN}/x`, "source_url_host_refused"],
		];
		for (const [url, code] of cases)
			expect(
				refusal(() => checkSourceUrl(url, OWN)),
				url,
			).toBe(code);
	});
});

describe("fetchTemplateSource", () => {
	afterEach(() => vi.restoreAllMocks());
	const doc = JSON.stringify({ templates: [{ id: "welcome", subject: "Hola" }] });
	const ok = (body: string, headers: Record<string, string> = {}) =>
		new Response(body, {
			status: 200,
			headers: { "content-type": "application/json", ...headers },
		});

	it("fetches without credentials, returns templates, hash and a query-less record URL", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok(doc));
		const got = await fetchTemplateSource("https://files.example.net/t.json?token=SECRET", {
			ownHost: OWN,
			expectedSha256: (await sha(doc)).toUpperCase(),
		});
		expect(got.templates).toEqual([{ id: "welcome", subject: "Hola" }]);
		expect(got.source).toEqual({
			url: "https://files.example.net/t.json?…",
			sha256: await sha(doc),
			bytes: doc.length,
		});
		expect(JSON.stringify(got.source)).not.toContain("SECRET");
		const init = spy.mock.calls[0]![1]!;
		expect(init.redirect).toBe("manual");
		const headers = new Headers(init.headers);
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("cookie")).toBeNull();
	});

	it("accepts a bare array", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(ok('[{"id":"a","subject":"A"}]'));
		const got = await fetchTemplateSource("https://files.example.net/t.json", { ownHost: OWN });
		expect(got.templates).toHaveLength(1);
	});

	it("re-checks every redirect hop", async () => {
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "https://cdn.example.net/t.json" },
				}),
			)
			.mockResolvedValueOnce(ok(doc));
		await expect(
			fetchTemplateSource("https://files.example.net/t.json", { ownHost: OWN }),
		).resolves.toMatchObject({ source: { url: "https://files.example.net/t.json" } });
		expect(spy).toHaveBeenCalledTimes(2);

		spy.mockReset();
		spy.mockResolvedValueOnce(
			new Response(null, { status: 301, headers: { location: "http://169.254.169.254/" } }),
		);
		await expect(
			fetchTemplateSource("https://files.example.net/t.json", { ownHost: OWN }),
		).rejects.toMatchObject({ code: "source_url_not_https" });
		expect(spy).toHaveBeenCalledTimes(1);

		spy.mockReset();
		spy.mockImplementation(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://files.example.net/loop" },
				}),
		);
		await expect(
			fetchTemplateSource("https://files.example.net/t.json", { ownHost: OWN }),
		).rejects.toMatchObject({ code: "source_too_many_redirects" });
		expect(spy).toHaveBeenCalledTimes(4);
	});

	it("refuses failed, oversized, HTML, non-JSON, mismatched and unsupported documents", async () => {
		const url = "https://files.example.net/t.json";
		const cases: Array<[Response | Error, string, string?]> = [
			[new Response("nope", { status: 404 }), "source_http_error"],
			[ok("x", { "content-length": String(MAX_SOURCE_BYTES + 1) }), "source_too_large"],
			[ok("a".repeat(MAX_SOURCE_BYTES + 10)), "source_too_large"],
			[
				new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
				"source_not_json",
			],
			[ok("{not json"), "source_not_json"],
			[ok('{"templates":[],"archiveMissing":true}'), "source_unsupported_field"],
			[ok('{"items":[]}'), "source_unsupported_field"],
			[ok('"just a string"'), "source_shape"],
			[ok(doc), "source_hash_mismatch", "0".repeat(64)],
			[Object.assign(new Error("t"), { name: "TimeoutError" }), "source_timeout"],
			[new TypeError("network"), "source_fetch_failed"],
		];
		for (const [answer, code, expectedSha256] of cases) {
			vi.restoreAllMocks();
			const spy = vi.spyOn(globalThis, "fetch");
			if (answer instanceof Error) spy.mockRejectedValue(answer);
			else spy.mockResolvedValue(answer);
			await expect(
				fetchTemplateSource(url, { ownHost: OWN, expectedSha256 }),
				code,
			).rejects.toMatchObject({ code });
		}
	});

	it("never fetches a refused URL", async () => {
		const spy = vi.spyOn(globalThis, "fetch");
		await expect(
			fetchTemplateSource("http://files.example.net/t.json", { ownHost: OWN }),
		).rejects.toMatchObject({ code: "source_url_not_https" });
		expect(spy).not.toHaveBeenCalled();
	});
});
