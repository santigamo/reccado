import { describe, expect, it } from "vitest";
import {
	interpolateTemplate,
	transactionalRequestSchema,
	checkRecipientPolicy,
	transactionalPayloadHash,
	validateTemplateVariables,
	extractTemplateVariables,
	httpStatusForTransactionalResult,
	transactionalResponseStatuses,
} from "#/lib/transactional-send";

describe("transactionalRequestSchema", () => {
	it("accepts a valid request", () => {
		const result = transactionalRequestSchema.safeParse({
			template: "welcome_v1",
			to: "user@example.com",
			variables: { name: "Alice" },
		});
		expect(result.success).toBe(true);
	});

	it("rejects missing template", () => {
		const result = transactionalRequestSchema.safeParse({
			to: "user@example.com",
		});
		expect(result.success).toBe(false);
	});

	it("rejects invalid email", () => {
		const result = transactionalRequestSchema.safeParse({
			template: "welcome_v1",
			to: "not-an-email",
		});
		expect(result.success).toBe(false);
	});

	it("rejects too many variables (>50)", () => {
		const variables: Record<string, string> = {};
		for (let i = 0; i < 51; i++) {
			variables[`var${i}`] = "value";
		}
		const result = transactionalRequestSchema.safeParse({
			template: "t",
			to: "a@b.com",
			variables,
		});
		expect(result.success).toBe(false);
	});

	it("rejects variable value exceeding 10K chars", () => {
		const result = transactionalRequestSchema.safeParse({
			template: "t",
			to: "a@b.com",
			variables: { x: "a".repeat(10_001) },
		});
		expect(result.success).toBe(false);
	});

	it("defaults variables to empty object", () => {
		const result = transactionalRequestSchema.safeParse({
			template: "t",
			to: "a@b.com",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.variables).toEqual({});
		}
	});
});

describe("interpolateTemplate", () => {
	it("replaces variables in subject and body", () => {
		const result = interpolateTemplate(
			{
				subject: "Hello {{name}}",
				body_text: "Welcome {{name}}!",
				body_html: "<p>Welcome {{name}}!</p>",
			},
			{ name: "Alice" },
		);
		expect(result).not.toBeNull();
		expect(result!.subject).toBe("Hello Alice");
		expect(result!.body_text).toBe("Welcome Alice!");
		expect(result!.body_html).toBe("<p>Welcome Alice!</p>");
	});

	it("returns null for CR/LF in subject", () => {
		const result = interpolateTemplate(
			{
				subject: "Hello {{name}}",
				body_text: null,
				body_html: null,
			},
			{ name: "Alice\nBob" },
		);
		expect(result).toBeNull();
	});

	it("returns null for newline in subject from template", () => {
		const result = interpolateTemplate(
			{
				subject: "Hello\nWorld",
				body_text: null,
				body_html: null,
			},
			{},
		);
		expect(result).toBeNull();
	});

	it("HTML-escapes variables in body_html only", () => {
		const result = interpolateTemplate(
			{
				subject: "Hi {{name}}",
				body_text: "{{name}} says <b>hello</b>",
				body_html: "<p>{{name}} says <b>hello</b></p>",
			},
			{ name: "<script>alert('xss')</script>" },
		);
		expect(result).not.toBeNull();
		// Subject and text body should have literal value
		expect(result!.subject).toBe("Hi <script>alert('xss')</script>");
		expect(result!.body_text).toBe("<script>alert('xss')</script> says <b>hello</b>");
		// HTML body should escape
		expect(result!.body_html).toBe(
			"<p>&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt; says <b>hello</b></p>",
		);
	});

	it("preserves unmatched {{placeholders}}", () => {
		const result = interpolateTemplate(
			{
				subject: "Hello {{name}}",
				body_text: null,
				body_html: null,
			},
			{},
		);
		expect(result).not.toBeNull();
		expect(result!.subject).toBe("Hello {{name}}");
	});

	it("truncates long subject to 998 chars", () => {
		const long = "x".repeat(2000);
		const result = interpolateTemplate({ subject: long, body_text: null, body_html: null }, {});
		expect(result).not.toBeNull();
		expect(result!.subject.length).toBe(998);
	});

	it("truncates long body to 100K chars", () => {
		const long = "x".repeat(200_000);
		const result = interpolateTemplate(
			{
				subject: "s",
				body_text: long,
				body_html: null,
			},
			{},
		);
		expect(result).not.toBeNull();
		expect(result!.body_text!.length).toBe(100_000);
	});

	it("returns null when variable count exceeds 50", () => {
		const vars: Record<string, string> = {};
		for (let i = 0; i < 51; i++) {
			vars[`k${i}`] = "v";
		}
		const result = interpolateTemplate(
			{
				subject: "Hello {{k0}}",
				body_text: null,
				body_html: null,
			},
			vars,
		);
		expect(result).toBeNull();
	});
});

describe("extractTemplateVariables", () => {
	it("extracts all variable names from a template", () => {
		const names = extractTemplateVariables({
			subject: "Hello {{name}}",
			body_text: "Your code is {{code}}",
			body_html: "<p>Thanks {{name}}</p>",
		});
		expect([...names].sort()).toEqual(["code", "name"]);
	});

	it("returns empty set for template with no variables", () => {
		const names = extractTemplateVariables({
			subject: "Hello",
			body_text: null,
			body_html: null,
		});
		expect(names.size).toBe(0);
	});
});

describe("validateTemplateVariables", () => {
	it("passes when all variables match", () => {
		const result = validateTemplateVariables(
			{
				subject: "Hello {{name}}",
				body_text: null,
				body_html: null,
			},
			{ name: "Alice" },
		);
		expect(result.ok).toBe(true);
		expect(result.missing).toEqual([]);
		expect(result.unknown).toEqual([]);
	});

	it("detects missing variables", () => {
		const result = validateTemplateVariables(
			{
				subject: "Hello {{name}}",
				body_text: "Code: {{code}}",
				body_html: null,
			},
			{},
		);
		expect(result.ok).toBe(false);
		expect(result.missing.sort()).toEqual(["code", "name"]);
	});

	it("detects unknown variables", () => {
		const result = validateTemplateVariables(
			{
				subject: "Hello {{name}}",
				body_text: null,
				body_html: null,
			},
			{ name: "Alice", extra: "value" },
		);
		expect(result.ok).toBe(false);
		expect(result.unknown).toEqual(["extra"]);
	});
});

describe("checkRecipientPolicy", () => {
	it("allows any recipient when policy is null", () => {
		expect(checkRecipientPolicy("a@b.com", null).allowed).toBe(true);
	});

	it("allows any recipient when policy is empty", () => {
		expect(checkRecipientPolicy("a@b.com", "").allowed).toBe(true);
	});

	it("allows matching domain policy", () => {
		const result = checkRecipientPolicy("user@example.com", "@example.com");
		expect(result.allowed).toBe(true);
	});

	it("denies non-matching domain policy", () => {
		const result = checkRecipientPolicy("user@other.com", "@example.com");
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("not_allowed_by_policy");
	});

	it("denies explicit deny rule", () => {
		const result = checkRecipientPolicy("blocked@example.com", "!blocked@example.com");
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("denied_by_policy");
	});

	it("allows exact match", () => {
		const result = checkRecipientPolicy("user@example.com", "user@example.com");
		expect(result.allowed).toBe(true);
	});

	it("supports deny-then-allow pattern", () => {
		const result = checkRecipientPolicy("user@example.com", "!spam@example.com,@example.com");
		expect(result.allowed).toBe(true);
	});

	it("denies when only deny rules present and match", () => {
		const result = checkRecipientPolicy("blocked@example.com", "!blocked@example.com");
		expect(result.allowed).toBe(false);
	});

	it("allows non-denied address in deny-only policy", () => {
		const result = checkRecipientPolicy("other@example.com", "!blocked@example.com");
		expect(result.allowed).toBe(true);
	});
});

describe("transactionalPayloadHash", () => {
	it("produces same hash for same inputs", async () => {
		const hash1 = await transactionalPayloadHash({
			keyId: "k1",
			clientIdempotencyKey: "ik1",
			template: "t1",
			to: "a@b.com",
			variables: { name: "Alice" },
		});
		const hash2 = await transactionalPayloadHash({
			keyId: "k1",
			clientIdempotencyKey: "ik1",
			template: "t1",
			to: "a@b.com",
			variables: { name: "Alice" },
		});
		expect(hash1).toBe(hash2);
	});

	it("produces different hash for different payloads", async () => {
		const hash1 = await transactionalPayloadHash({
			keyId: "k1",
			clientIdempotencyKey: "ik1",
			template: "t1",
			to: "a@b.com",
			variables: { name: "Alice" },
		});
		const hash2 = await transactionalPayloadHash({
			keyId: "k1",
			clientIdempotencyKey: "ik1",
			template: "t1",
			to: "a@b.com",
			variables: { name: "Bob" },
		});
		expect(hash1).not.toBe(hash2);
	});

	it("produces different hash for different keys", async () => {
		const hash1 = await transactionalPayloadHash({
			keyId: "k1",
			clientIdempotencyKey: "ik1",
			template: "t1",
			to: "a@b.com",
			variables: {},
		});
		const hash2 = await transactionalPayloadHash({
			keyId: "k2",
			clientIdempotencyKey: "ik1",
			template: "t1",
			to: "a@b.com",
			variables: {},
		});
		expect(hash1).not.toBe(hash2);
	});

	it("is case-insensitive for email and canonical string", async () => {
		const hash1 = await transactionalPayloadHash({
			keyId: "k1",
			clientIdempotencyKey: "ik1",
			template: "t1",
			to: "A@B.com",
			variables: {},
		});
		const hash2 = await transactionalPayloadHash({
			keyId: "k1",
			clientIdempotencyKey: "ik1",
			template: "t1",
			to: "a@b.com",
			variables: {},
		});
		expect(hash1).toBe(hash2);
	});
});

describe("httpStatusForTransactionalResult", () => {
	it("returns 2xx only when the message was accepted by the provider", () => {
		expect(httpStatusForTransactionalResult({ status: "sent" })).toBe(200);
		expect(httpStatusForTransactionalResult({ status: "duplicate" })).toBe(200);
		expect(httpStatusForTransactionalResult({ status: "accepted" })).toBe(202);
	});

	// The regression this file exists for: these two used to return 200, so the
	// obvious client (throw on non-2xx) reported an undelivered message as sent.
	it("never returns 2xx for a failed or unresolved send", () => {
		expect(httpStatusForTransactionalResult({ status: "permanent_failure" })).toBe(502);
		expect(httpStatusForTransactionalResult({ status: "unknown" })).toBe(504);
	});

	it("distinguishes a definite failure from an unknown outcome by status alone", () => {
		expect(httpStatusForTransactionalResult({ status: "permanent_failure" })).not.toBe(
			httpStatusForTransactionalResult({ status: "unknown" }),
		);
	});

	it("maps rejections to the reason the caller can act on", () => {
		expect(
			httpStatusForTransactionalResult({ status: "rejected", error: "missing_authorization" }),
		).toBe(401);
		expect(
			httpStatusForTransactionalResult({ status: "rejected", error: "idempotency_key_required" }),
		).toBe(400);
		expect(httpStatusForTransactionalResult({ status: "rejected", error: "quota_exceeded" })).toBe(
			429,
		);
		expect(
			httpStatusForTransactionalResult({ status: "rejected", error: "insufficient_scope" }),
		).toBe(403);
		expect(httpStatusForTransactionalResult({ status: "rejected" })).toBe(403);
	});

	it("returns 409 for an idempotency conflict", () => {
		expect(httpStatusForTransactionalResult({ status: "idempotency_conflict" })).toBe(409);
	});

	// Guards the switch: a new response status must be given a code deliberately
	// rather than falling through to whatever the last branch happened to be.
	it("assigns a status code to every declared response status", () => {
		for (const status of transactionalResponseStatuses) {
			const code = httpStatusForTransactionalResult({ status });
			expect(typeof code).toBe("number");
			expect(code).toBeGreaterThanOrEqual(200);
		}
	});
});
