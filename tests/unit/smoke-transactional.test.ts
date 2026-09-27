import { describe, expect, it } from "vitest";
import {
	assessArchive,
	assessDelivery,
	assessKeyCreate,
	assessKeyListed,
	assessPolicyRejection,
	assessReplay,
	assessRevoke,
	assessRoutingDestination,
	assessSend,
	assessSenderName,
	assessStatus,
	buildIntegratorRequest,
	buildKeyBody,
	buildSendPayload,
	buildTemplateBody,
	DEFAULT_SENDER_NAME,
	extractKey,
	formatStep,
	hasFailure,
	isTerminalDelivery,
	KEY_QUOTA_MAX,
	KEY_TTL_MS,
	makeRunIds,
	manualCheckLine,
	manualCleanupCommands,
	POLICY_REJECT_ADDRESS,
	parseRoutingDestinations,
	parseSmokeArgs,
	planLines,
	SmokeInputError,
	type StatusView,
	step,
	summaryLine,
	toHttpResult,
} from "../../scripts/lib/smoke-transactional-core";
import { checkRecipientPolicy, validateTemplateId } from "../../src/lib/transactional-send";

const PLAINTEXT = "FAKE-plaintext-key-for-redaction-tests-0000";
const REQUIRED = [
	"--mailbox",
	"mbx_abc123",
	"--sender",
	"hola@send.example.com",
	"--to",
	"me@example.com",
];

function http(status: number, body: unknown) {
	return toHttpResult(status, body === undefined ? "" : JSON.stringify(body));
}

const projection = {
	keyId: "key_1",
	mailboxId: "mbx_abc123",
	sender: "hola@send.example.com",
	senderName: null as string | null,
	displaySuffix: "WXYZ",
	environment: "live",
	scopes: ["transactional:send"],
	templateAllowlist: ["smoke-1"],
	recipientPolicy: "me@example.com",
	status: "active",
	quotaMax: 5,
	quotaUsed: 0,
	expiresAt: "2026-09-24T11:00:00.000Z",
	createdAt: "2026-09-24T10:00:00.000Z",
	updatedAt: "2026-09-24T10:00:00.000Z",
	revokedAt: null,
};

describe("parseSmokeArgs", () => {
	it("parses required flags and applies defaults (no send, no wait)", () => {
		const opts = parseSmokeArgs(REQUIRED);
		expect(opts).toMatchObject({
			mailboxId: "mbx_abc123",
			sender: "hola@send.example.com",
			to: "me@example.com",
			senderName: DEFAULT_SENDER_NAME,
			send: false,
			waitDeliverySeconds: 0,
			help: false,
		});
		expect(opts.env).toBeUndefined();
		expect(opts.host).toBeUndefined();
	});

	it("accepts --flag=value, --send, --wait-delivery and normalizes --host", () => {
		const opts = parseSmokeArgs([
			...REQUIRED,
			"--env=dev",
			"--host",
			"https://Inbox.Example.com/",
			"--sender-name",
			"Acme Mail",
			"--send",
			"--wait-delivery",
			"60",
		]);
		expect(opts).toMatchObject({
			env: "dev",
			host: "inbox.example.com",
			senderName: "Acme Mail",
			send: true,
			waitDeliverySeconds: 60,
		});
	});

	it("refuses unknown flags so a typo cannot flip the send mode", () => {
		expect(() => parseSmokeArgs([...REQUIRED, "--sned"])).toThrow(SmokeInputError);
		expect(() => parseSmokeArgs([...REQUIRED, "--send=yes"])).toThrow(SmokeInputError);
		expect(() => parseSmokeArgs([...REQUIRED, "stray"])).toThrow(SmokeInputError);
	});

	it("requires mailbox, sender and to, and validates them", () => {
		expect(() => parseSmokeArgs([])).toThrow(/--mailbox, --sender, --to/);
		expect(() => parseSmokeArgs(["--mailbox", "--send"])).toThrow(/needs a value/);
		const bad = (flag: string, value: string) => {
			const argv = [...REQUIRED];
			argv[argv.indexOf(flag) + 1] = value;
			return () => parseSmokeArgs(argv);
		};
		expect(bad("--mailbox", "mbx/../x")).toThrow(SmokeInputError);
		expect(bad("--sender", "not-an-email")).toThrow(SmokeInputError);
		expect(bad("--to", "Name <me@example.com>")).toThrow(SmokeInputError);
		expect(bad("--to", POLICY_REJECT_ADDRESS)).toThrow(/policy probe/);
	});

	it("bounds --wait-delivery", () => {
		for (const v of ["-1", "1.5", "abc", "3601"]) {
			expect(() => parseSmokeArgs([...REQUIRED, "--wait-delivery", v])).toThrow(SmokeInputError);
		}
		expect(parseSmokeArgs([...REQUIRED, "--wait-delivery", "3600"]).waitDeliverySeconds).toBe(3600);
	});

	it("--help needs nothing else", () => {
		expect(parseSmokeArgs(["--help"]).help).toBe(true);
	});
});

describe("run ids and request bodies", () => {
	const ids = makeRunIds(1_727_172_000_000, "0123456789abcdef");

	it("makes a template id the send path accepts and distinct idempotency keys", () => {
		expect(ids.templateId).toBe("smoke-1727172000000");
		expect(validateTemplateId(ids.templateId)).toBe(true);
		expect(ids.idempotencyKey).not.toBe(ids.rejectIdempotencyKey);
		expect(ids.token).toContain("01234567");
		expect(() => makeRunIds(1, "xyz")).toThrow(SmokeInputError);
	});

	it("puts the token in the subject literally and {{token}} in both bodies", () => {
		const t = buildTemplateBody(ids);
		expect(t.id).toBe(ids.templateId);
		expect(t.subject).toContain(ids.token);
		expect(t.subject).not.toMatch(/[\r\n]/);
		expect(t.body_text).toContain("{{token}}");
		expect(t.body_html).toContain("{{token}}");
		expect(buildSendPayload(ids, "me@example.com")).toEqual({
			template: ids.templateId,
			to: "me@example.com",
			variables: { token: ids.token },
		});
	});

	it("builds a narrow live key: exact recipient policy, allowlisted template, small quota, 1h", () => {
		const now = Date.parse("2026-09-24T10:00:00.000Z");
		const body = buildKeyBody({
			sender: "hola@send.example.com",
			to: "me@example.com",
			templateId: ids.templateId,
			nowMs: now,
		});
		expect(body).toEqual({
			environment: "live",
			sender: "hola@send.example.com",
			scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
			templateAllowlist: [ids.templateId],
			recipientPolicy: "me@example.com",
			quotaMax: KEY_QUOTA_MAX,
			expiresAt: new Date(now + KEY_TTL_MS).toISOString(),
		});
		// The policy the key is created with allows --to and refuses the probe address.
		expect(checkRecipientPolicy("me@example.com", body.recipientPolicy).allowed).toBe(true);
		expect(checkRecipientPolicy(POLICY_REJECT_ADDRESS, body.recipientPolicy)).toEqual({
			allowed: false,
			reason: "not_allowed_by_policy",
		});
	});

	it("builds integrator requests with Bearer auth and a mandatory Idempotency-Key on POST", () => {
		const post = buildIntegratorRequest({
			host: "inbox.example.com",
			mailboxId: "mbx_abc123",
			apiKey: PLAINTEXT,
			method: "POST",
			idempotencyKey: "idem-1",
			body: { a: 1 },
		});
		expect(post.url).toBe(
			"https://inbox.example.com/v1/mailboxes/mbx_abc123/transactional/messages",
		);
		const headers = post.init.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Bearer ${PLAINTEXT}`);
		expect(headers["idempotency-key"]).toBe("idem-1");
		expect(headers["content-type"]).toBe("application/json");
		expect(post.init.body).toBe('{"a":1}');
		expect(() =>
			buildIntegratorRequest({
				host: "h.example.com",
				mailboxId: "m",
				apiKey: "k",
				method: "POST",
			}),
		).toThrow(SmokeInputError);

		const get = buildIntegratorRequest({
			host: "localhost:3000",
			mailboxId: "mbx_abc123",
			apiKey: PLAINTEXT,
			method: "GET",
			requestId: "req-1",
		});
		expect(get.url).toBe(
			"http://localhost:3000/v1/mailboxes/mbx_abc123/transactional/messages/req-1",
		);
		expect((get.init.headers as Record<string, string>)["idempotency-key"]).toBeUndefined();
	});
});

describe("key assertions", () => {
	it("passes a 201 with a plaintext key, never echoing the key", () => {
		const r = assessKeyCreate(
			http(201, { key: projection, plaintextKey: PLAINTEXT, auditEvent: { id: "e" }, projection }),
		);
		expect(r.step.outcome).toBe("PASS");
		expect(r.keyId).toBe("key_1");
		expect(r.plaintextKey).toBe(PLAINTEXT);
		expect(formatStep(r.step)).not.toContain(PLAINTEXT);
		expect(formatStep(r.step)).toContain("present");
	});

	it("fails the lost-key regression: 201 without plaintextKey, or a 500", () => {
		const missing = assessKeyCreate(http(201, { key: projection, projection }));
		expect(missing.step.outcome).toBe("FAIL");
		expect(formatStep(missing.step)).toContain("MISSING");
		const crashed = assessKeyCreate(http(500, { error: "boom", plaintextKey: PLAINTEXT }));
		expect(crashed.step.outcome).toBe("FAIL");
		expect(formatStep(crashed.step)).not.toContain(PLAINTEXT);
	});

	it("reads the key out of every admin envelope", () => {
		expect(extractKey({ key: projection, plaintextKey: PLAINTEXT })?.keyId).toBe("key_1");
		expect(
			extractKey({ key: { key: { ...projection, senderName: "N" }, projection } })?.senderName,
		).toBe("N");
		expect(extractKey({ key: { projection: { ...projection, status: "revoked" } } })?.status).toBe(
			"revoked",
		);
		expect(extractKey({ error: "x" })).toBeUndefined();
	});

	it("checks the key is listed and active", () => {
		expect(assessKeyListed(http(200, { keys: [projection] }), "key_1").outcome).toBe("PASS");
		expect(assessKeyListed(http(200, { keys: [] }), "key_1").outcome).toBe("FAIL");
		expect(
			assessKeyListed(http(200, { keys: [{ ...projection, status: "revoked" }] }), "key_1").outcome,
		).toBe("FAIL");
		expect(assessKeyListed(http(403, { error: "nope" }), "key_1").outcome).toBe("FAIL");
	});

	it("requires the PATCH and the re-read to both report the sender name", () => {
		const named = { ...projection, senderName: "Reccado smoke" };
		const patch = http(200, { key: { key: named, auditEvent: { id: "e" }, projection: named } });
		expect(
			assessSenderName(patch, http(200, { keys: [named] }), "key_1", "Reccado smoke").outcome,
		).toBe("PASS");
		expect(
			assessSenderName(patch, http(200, { keys: [projection] }), "key_1", "Reccado smoke").outcome,
		).toBe("FAIL");
		expect(
			assessSenderName(http(400, { error: "invalid_sender_name" }), undefined, "key_1", "x")
				.outcome,
		).toBe("FAIL");
	});

	it("revoke must read back revoked; archive must answer ok", () => {
		const revoked = { ...projection, status: "revoked" };
		expect(assessRevoke(http(200, { key: { key: revoked, projection: revoked } })).outcome).toBe(
			"PASS",
		);
		expect(assessRevoke(http(200, { key: { key: projection } })).outcome).toBe("FAIL");
		expect(assessRevoke(http(404, { error: "key_not_found" })).outcome).toBe("FAIL");
		expect(assessArchive(http(200, { ok: true }), "t").outcome).toBe("PASS");
		expect(assessArchive(http(404, { error: "template_not_found" }), "t").outcome).toBe("FAIL");
	});
});

describe("send assertions", () => {
	const sentBody = {
		status: "sent",
		requestId: "req-1",
		keyId: "key_1",
		providerMessageId: "pm-1",
	};

	it("passes sent + providerMessageId and fails anything else", () => {
		expect(assessSend(http(200, sentBody)).step.outcome).toBe("PASS");
		expect(assessSend(http(200, { ...sentBody, providerMessageId: null })).step.outcome).toBe(
			"FAIL",
		);
		const unknown = assessSend(
			http(504, { status: "unknown", requestId: "req-1", error: "timeout" }),
		);
		expect(unknown.step.outcome).toBe("FAIL");
		expect(formatStep(unknown.step)).toContain("do NOT resend");
		expect(assessSend(toHttpResult(502, "<html>bad gateway</html>")).step.outcome).toBe("FAIL");
	});

	it("replay must return the original requestId and providerMessageId", () => {
		const original = assessSend(http(200, sentBody)).send;
		expect(assessReplay(original, http(200, sentBody)).outcome).toBe("PASS");
		expect(assessReplay(original, http(200, { ...sentBody, status: "duplicate" })).outcome).toBe(
			"PASS",
		);
		// A new request id or provider id means the replay reached the provider again.
		expect(assessReplay(original, http(200, { ...sentBody, requestId: "req-2" })).outcome).toBe(
			"FAIL",
		);
		expect(
			assessReplay(original, http(200, { ...sentBody, providerMessageId: "pm-2" })).outcome,
		).toBe("FAIL");
		expect(
			assessReplay(original, http(409, { status: "idempotency_conflict", requestId: "req-1" }))
				.outcome,
		).toBe("FAIL");
		const noProvider = assessSend(http(200, { ...sentBody, providerMessageId: null })).send;
		expect(
			assessReplay(noProvider, http(200, { ...sentBody, providerMessageId: null })).outcome,
		).toBe("FAIL");
	});

	it("policy probe must be a 403 not_allowed_by_policy with nothing reserved", () => {
		const rejected = {
			status: "rejected",
			requestId: "",
			keyId: "key_1",
			error: "not_allowed_by_policy",
		};
		expect(assessPolicyRejection(http(403, rejected)).outcome).toBe("PASS");
		expect(
			assessPolicyRejection(http(403, { ...rejected, error: "recipient_suppressed" })).outcome,
		).toBe("FAIL");
		expect(assessPolicyRejection(http(200, sentBody)).outcome).toBe("FAIL");
	});
});

describe("status and delivery", () => {
	const statusBody = (over: Record<string, unknown> = {}) => ({
		requestId: "req-1",
		status: "sent",
		providerMessageId: "pm-1",
		createdAt: "2026-09-24T10:00:00.000Z",
		errorCode: null,
		deliveryStatus: null,
		deliveryEventAt: null,
		resolvedVia: null,
		deliveryFeedback: { state: "unobserved", reason: "too early" },
		...over,
	});
	const view = (over: Partial<StatusView> = {}): StatusView => ({
		status: "sent",
		providerMessageId: "pm-1",
		deliveryStatus: null,
		deliveryEventAt: null,
		resolvedVia: null,
		feedbackState: "unobserved",
		feedbackReason: null,
		...over,
	});

	it("status must agree with the send and prints deliveryFeedback", () => {
		const send = { status: "sent", requestId: "req-1", providerMessageId: "pm-1" };
		const ok = assessStatus(http(200, statusBody()), send);
		expect(ok.outcome).toBe("PASS");
		expect(formatStep(ok)).toContain("deliveryFeedback=unobserved");
		expect(assessStatus(http(200, statusBody({ providerMessageId: "other" })), send).outcome).toBe(
			"FAIL",
		);
		expect(assessStatus(http(403, { error: "insufficient_scope" }), send).outcome).toBe("FAIL");
	});

	it("delivered passes; bounce fails; a non-terminal event is a warning", () => {
		expect(
			assessDelivery(view({ deliveryStatus: "delivered", deliveryEventAt: "t" }), 5).outcome,
		).toBe("PASS");
		expect(assessDelivery(view({ deliveryStatus: "bounced" }), 5).outcome).toBe("FAIL");
		expect(assessDelivery(view({ deliveryStatus: "deferred" }), 5).outcome).toBe("WARN");
		expect(isTerminalDelivery(view({ deliveryStatus: "deferred" }))).toBe(false);
		expect(isTerminalDelivery(view({ deliveryStatus: "delivered" }))).toBe(true);
	});

	it("silence is a failure only when feedback liveness says the channel is live", () => {
		for (const state of ["unobserved", "never_observed", "went_dark", "absent"]) {
			const r = assessDelivery(view({ feedbackState: state }), 30);
			expect(r.outcome).toBe("WARN");
			expect(formatStep(r)).toContain(
				`no event within 30 s (check the domain's feedback liveness: deliveryFeedback=${state}`,
			);
		}
		expect(assessDelivery(view({ feedbackState: "live" }), 30).outcome).toBe("FAIL");
	});
});

describe("reporting", () => {
	const opts = parseSmokeArgs([...REQUIRED, "--send"]);
	const ids = makeRunIds(1_727_172_000_000, "0123456789abcdef");

	it("summarizes and exits non-zero only on FAIL", () => {
		const ok = [step("a", "PASS"), step("b", "WARN"), step("c", "SKIP")];
		expect(hasFailure(ok)).toBe(false);
		expect(summaryLine(ok)).toBe("RESULT: PASS (1 pass, 0 fail, 1 warn, 1 skipped)");
		expect(hasFailure([...ok, step("d", "FAIL")])).toBe(true);
		expect(formatStep(step("x", "PASS", ["one"]))).toBe("[PASS] x\n       one");
	});

	it("manual cleanup commands name the ids and read the cookie from the session file", () => {
		const lines = manualCleanupCommands({
			host: "inbox.example.com",
			env: "dev",
			mailboxId: "mbx_abc123",
			keyId: "key_1",
			templateId: ids.templateId,
			sessionPath: "/home/o/.config/reccado/sessions/inbox.example.com.json",
		}).join("\n");
		expect(lines).toContain("/api/mailboxes/mbx_abc123/transactional/api-keys/key_1/revoke");
		expect(lines).toContain(
			`/api/mailboxes/mbx_abc123/transactional/templates/${ids.templateId}/archive`,
		);
		expect(lines).toContain("origin: https://inbox.example.com");
		expect(lines).toContain(
			"jq -r .cookie '/home/o/.config/reccado/sessions/inbox.example.com.json'",
		);
		expect(lines).toContain("pnpm operator login --env dev --host inbox.example.com");
	});

	it("plan and manual check name the sender identity to verify", () => {
		const plan = planLines(opts, "inbox.example.com", ids).join("\n");
		expect(plan).toContain("SEND");
		expect(plan).toContain(ids.templateId);
		expect(planLines({ ...opts, send: false }, "inbox.example.com", ids).join("\n")).toContain(
			"plan only",
		);
		const check = manualCheckLine(opts, ids, "pm-1");
		expect(check).toContain(`"${DEFAULT_SENDER_NAME} <hola@send.example.com>"`);
		expect(check).toContain("SPF, DKIM and DMARC");
		expect(check).toContain(ids.token);
	});
});

describe("Email Routing destination guard for --wait-delivery", () => {
	// Shaped like GET /accounts/{account_id}/email/routing/addresses `result`.
	const apiResult = [
		{
			id: "ea95132c15732412d22c1476fa83f27a",
			email: "Owner@Example.com",
			verified: "2026-01-01T00:00:00Z",
			created: "2026-01-01T00:00:00Z",
			modified: "2026-01-01T00:00:00Z",
		},
		{ id: "b", email: "pending@example.com", verified: null },
		{ id: "c" },
	];

	it("parses destinations, lowercased, verified only when the timestamp is set", () => {
		expect(parseRoutingDestinations(apiResult)).toEqual([
			{ email: "owner@example.com", verified: true },
			{ email: "pending@example.com", verified: false },
		]);
		expect(parseRoutingDestinations(null)).toEqual([]);
		expect(parseRoutingDestinations({ email: "x@example.com" })).toEqual([]);
	});

	it("skips the wait with a WARN when --to is a verified destination address", () => {
		const decision = assessRoutingDestination("owner@example.com", {
			ok: true,
			destinations: parseRoutingDestinations(apiResult),
		});
		expect(decision.skipWait).toBe(true);
		expect(decision.step.outcome).toBe("WARN");
		const text = decision.step.evidence.join("\n");
		expect(text).toContain("verified Email Routing destination address");
		expect(text).toContain("never produces an Email Sending lifecycle event");
		expect(text).toContain("unobserved");
		// A WARN, never a FAIL: the send is fine, only the wait would be meaningless.
		expect(hasFailure([decision.step])).toBe(false);
	});

	it("still waits for an unverified destination or any other recipient", () => {
		const destinations = parseRoutingDestinations(apiResult);
		for (const to of ["pending@example.com", "someone@elsewhere.example"]) {
			const decision = assessRoutingDestination(to, { ok: true, destinations });
			expect(decision.skipWait).toBe(false);
			expect(decision.step.outcome).toBe("INFO");
		}
	});

	it("still waits, with an INFO, when the destination list cannot be read", () => {
		const decision = assessRoutingDestination("owner@example.com", {
			ok: false,
			reason: "CLOUDFLARE_API_TOKEN is not set",
		});
		expect(decision.skipWait).toBe(false);
		expect(decision.step.outcome).toBe("INFO");
		expect(decision.step.evidence.join("\n")).toContain("CLOUDFLARE_API_TOKEN is not set");
	});
});
