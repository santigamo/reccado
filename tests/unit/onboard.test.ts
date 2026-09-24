import { describe, expect, it } from "vitest";
import { parseDohMxAnswer } from "../../scripts/lib/dns-lookup";
import type { FeedbackSubscriptionVerdict } from "../../scripts/lib/event-subscriptions";
import {
	type AliasRowLike,
	type ApiKeyEntry,
	buildOnePasswordItem,
	type Decision,
	decideAlias,
	decideDeployedDomains,
	decideDomain,
	decideKey,
	decideMailbox,
	decideRoutingEnabled,
	decideRoutingRule,
	decideSendingConfig,
	decideSendingTarget,
	decideTemplates,
	dependencyMet,
	diffKey,
	diffTemplates,
	endpointFor,
	exitCodeFor,
	findItemsByTitle,
	formatResults,
	interpretTemplateSync,
	type KeyCreateBody,
	type MailboxRowLike,
	type Mode,
	type OnboardOutcome,
	parseDeploymentStatus,
	parseOpFields,
	parseTemplatesFile,
	parseVersionVars,
	type ResolvedManifest,
	resolveKeyBodies,
	runSteps,
	type SendingObservation,
	type StepSpec,
	settle,
	setupSendingArgs,
	validateManifest,
} from "../../scripts/lib/onboard-core";
import { parseRoutingRulesList, parseRoutingSettings } from "../../scripts/lib/routing";
import { planSendingConfigUpdate } from "../../scripts/lib/sending-config";
import type { ParsedDnsRecord } from "../../scripts/lib/sending-plan";

const GOOD = {
	zone: "example.com",
	sending: {
		subdomain: "send",
		apex: true,
		dmarc: { policy: "none", rua: "dmarc@example.com" },
	},
	mailbox: {
		address: "support@example.com",
		displayName: "Example",
		aliases: ["privacy@example.com", "dmarc@example.com"],
	},
	templates: { file: "./templates.json", archiveMissing: false },
	keys: [
		{
			name: "preview",
			sender: "hello@send.example.com",
			senderName: "Example",
			scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
			templates: "all",
			recipientPolicy: "me@example.org,@example.com",
			quotaMax: 50,
			store: { onePassword: { vault: "Personal", title: "Example Reccado API key (preview)" } },
		},
	],
};

function withChange(mutate: (m: typeof GOOD & Record<string, unknown>) => void): unknown {
	const copy = structuredClone(GOOD) as typeof GOOD & Record<string, unknown>;
	mutate(copy);
	return copy;
}

function resolved(): ResolvedManifest {
	const result = validateManifest(GOOD);
	if (!result.ok) throw new Error(result.errors.join("\n"));
	return result.value;
}

function errorsOf(raw: unknown): string[] {
	const result = validateManifest(raw);
	if (result.ok) throw new Error("expected the manifest to be rejected");
	return result.errors;
}

describe("validateManifest", () => {
	it("accepts the documented example and resolves both sending names", () => {
		const m = resolved();
		expect(m.zone).toBe("example.com");
		expect(m.sending.map((e) => e.target.sendingDomain)).toEqual([
			"send.example.com",
			"example.com",
		]);
		expect(m.sending[1]?.target.isApex).toBe(true);
		expect(m.sending[0]?.dmarc.value).toBe(
			"v=DMARC1; p=none; adkim=r; aspf=r; rua=mailto:dmarc@example.com",
		);
		expect(m.mailbox.aliases).toEqual(["privacy@example.com", "dmarc@example.com"]);
		expect(m.templates).toEqual({ file: "./templates.json", archiveMissing: false });
		expect(m.keys[0]?.environment).toBe("live");
		// setup:sending's "this run will replace the apex DMARC" is not an up-front warning here.
		expect(m.warnings.some((w) => w.includes("APEX DMARC"))).toBe(false);
	});

	it("lowercases addresses and normalizes the zone", () => {
		const m = validateManifest(
			withChange((c) => {
				c.zone = "Example.COM.";
				c.mailbox.address = "Support@Example.com";
			}),
		);
		expect(m.ok && m.value.zone).toBe("example.com");
		expect(m.ok && m.value.mailbox.address).toBe("support@example.com");
	});

	it("rejects unknown fields (strict)", () => {
		expect(errorsOf(withChange((c) => (c.extra = true))).join()).toMatch(/Unrecognized key/i);
	});

	it("requires a DMARC policy", () => {
		expect(
			errorsOf(
				withChange((c) => {
					(c.sending as Record<string, unknown>).dmarc = { rua: "dmarc@example.com" };
				}),
			).join(),
		).toMatch(/sending\.dmarc\.policy/);
	});

	it("rejects a key sender outside the provisioned names", () => {
		const errors = errorsOf(
			withChange((c) => {
				c.keys[0] = { ...c.keys[0]!, sender: "hello@mail.example.com" };
			}),
		);
		expect(errors.join()).toMatch(/not on a sending domain this manifest provisions/);
	});

	it("allows an apex sender only when the apex is provisioned", () => {
		const onApex = withChange((c) => {
			c.keys[0] = { ...c.keys[0]!, sender: "hello@example.com" };
		});
		expect(validateManifest(onApex).ok).toBe(true);
		const noApex = withChange((c) => {
			c.sending.apex = false;
			c.keys[0] = { ...c.keys[0]!, sender: "hello@example.com" };
		});
		expect(errorsOf(noApex).join()).toMatch(/hello@example\.com is not on a sending domain/);
	});

	it("runs the recipient policy through validateRecipientPolicy", () => {
		const errors = errorsOf(
			withChange((c) => {
				c.keys[0] = { ...c.keys[0]!, recipientPolicy: "me@example.org,,@*.example.com" };
			}),
		);
		expect(errors.join("\n")).toMatch(/empty rule/);
		expect(errors.join("\n")).toMatch(/wildcards are not supported/);
	});

	it("rejects aliases off the zone, duplicates, and the address itself", () => {
		const errors = errorsOf(
			withChange((c) => {
				c.mailbox.aliases = [
					"x@other.com",
					"support@example.com",
					"a@example.com",
					"a@example.com",
				];
			}),
		);
		expect(errors).toHaveLength(3);
		expect(errors.join("\n")).toMatch(/x@other\.com is not on example\.com/);
		expect(errors.join("\n")).toMatch(/is the mailbox address itself/);
		expect(errors.join("\n")).toMatch(/listed twice/);
	});

	it("rejects a mailbox off the zone", () => {
		expect(errorsOf(withChange((c) => (c.mailbox.address = "support@other.com"))).join()).toMatch(
			/is not on example\.com/,
		);
	});

	it("rejects duplicate key names and store targets", () => {
		const errors = errorsOf(withChange((c) => c.keys.push({ ...c.keys[0]! })));
		expect(errors.join("\n")).toMatch(/duplicate key name/);
		expect(errors.join("\n")).toMatch(/another key already stores/);
	});

	it("requires a templates file for key template references", () => {
		const errors = errorsOf(withChange((c) => delete (c as Record<string, unknown>).templates));
		expect(errors.join()).toMatch(/needs a top-level "templates\.file"/);
	});

	it("refuses a manifest that provisions nothing", () => {
		const errors = errorsOf(
			withChange((c) => {
				(c.sending as Record<string, unknown>).subdomain = false;
				c.sending.apex = false;
				c.keys = [];
			}),
		);
		expect(errors.join()).toMatch(/nothing to provision/);
	});

	it("rejects a malformed zone id and bad key names", () => {
		const errors = errorsOf(
			withChange((c) => {
				c.zoneId = "not-a-zone";
				c.keys[0] = { ...c.keys[0]!, name: "has space" };
			}),
		);
		expect(errors.join("\n")).toMatch(/zoneId/);
		expect(errors.join("\n")).toMatch(/keys\.0\.name/);
	});
});

describe("parseTemplatesFile / resolveKeyBodies", () => {
	const templates = [
		{ id: "magic-link", subject: "Sign in", body_text: "{{url}}" },
		{ id: "receipt", subject: "Receipt", body_html: "<p>{{total}}</p>" },
	];

	it("accepts a bare array or {templates: [...]}", () => {
		expect(parseTemplatesFile(templates).ok).toBe(true);
		expect(parseTemplatesFile({ templates }).ok).toBe(true);
	});

	it("rejects duplicate ids and missing subjects with the sync route's schema", () => {
		const dup = parseTemplatesFile([...templates, templates[0]]);
		expect(dup.ok).toBe(false);
		expect(!dup.ok && dup.errors.join()).toMatch(/duplicate_template_id/);
		expect(parseTemplatesFile([{ id: "x" }]).ok).toBe(false);
		expect(parseTemplatesFile("nope").ok).toBe(false);
	});

	it('expands templates: "all" to every file id and builds the exact create body', () => {
		const result = resolveKeyBodies(resolved().keys, ["magic-link", "receipt"]);
		expect(result.ok).toBe(true);
		const body = result.ok ? result.value.get("preview") : undefined;
		expect(body).toEqual({
			environment: "live",
			sender: "hello@send.example.com",
			senderName: "Example",
			scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
			templateAllowlist: ["magic-link", "receipt"],
			recipientPolicy: "me@example.org,@example.com",
			quotaMax: 50,
		});
	});

	it("rejects template ids that are not in the file", () => {
		const keys = [{ ...resolved().keys[0]!, templates: ["magic-link", "welcome"] }];
		const result = resolveKeyBodies(keys, ["magic-link"]);
		expect(!result.ok && result.errors.join()).toMatch(/not in the templates file: welcome/);
	});

	it("applies the server's key-shape rules (send needs an allowlist)", () => {
		const keys = [{ ...resolved().keys[0]!, templates: undefined }];
		const result = resolveKeyBodies(keys, ["magic-link"]);
		expect(!result.ok && result.errors.join()).toMatch(/templateAllowlist/);
	});

	it("rejects a sender name that cannot go in a header", () => {
		const keys = [{ ...resolved().keys[0]!, senderName: 'Bad "quote"' }];
		expect(resolveKeyBodies(keys, ["magic-link"]).ok).toBe(false);
	});
});

describe("runSteps (dependency skipping)", () => {
	const step = (id: string, deps: string[], outcome: OnboardOutcome | Error): StepSpec => ({
		id,
		deps,
		run: async () => {
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
	});

	it("skips only the dependents of a step that did not succeed", async () => {
		const ran: string[] = [];
		const track = (id: string, deps: string[], outcome: OnboardOutcome): StepSpec => ({
			id,
			deps,
			run: async () => {
				ran.push(id);
				return outcome;
			},
		});
		const results = await runSteps(
			[
				track("a", [], { state: "blocked", reason: "no token", remedy: "set it" }),
				track("b", ["a"], { state: "done", detail: "x" }),
				track("c", ["b"], { state: "done", detail: "x" }),
				track("d", [], { state: "already", detail: "x" }),
				track("e", ["d"], { state: "done", detail: "x" }),
			],
			"apply",
		);
		expect(results.map((r) => [r.id, r.outcome.state])).toEqual([
			["a", "blocked"],
			["b", "skipped"],
			["c", "skipped"],
			["d", "already"],
			["e", "done"],
		]);
		expect(ran).toEqual(["a", "d", "e"]);
		expect(results[1]?.outcome).toEqual({ state: "skipped", reason: "needs a (blocked)" });
		expect(results[2]?.outcome).toEqual({ state: "skipped", reason: "needs b (skipped)" });
	});

	it("treats would_do as a met dependency in a dry run only", async () => {
		const plan = [
			step("a", [], { state: "would_do", action: "create a" }),
			step("b", ["a"], { state: "would_do", action: "create b" }),
		];
		const dry = await runSteps(plan, "dry-run");
		expect(dry.map((r) => r.outcome.state)).toEqual(["would_do", "would_do"]);
		const apply = await runSteps(plan, "apply");
		expect(apply.map((r) => r.outcome.state)).toEqual(["would_do", "skipped"]);
		expect(dependencyMet({ state: "done", detail: "" }, "apply")).toBe(true);
		expect(dependencyMet({ state: "failed", error: "" }, "dry-run")).toBe(false);
	});

	it("turns a throw into that step's failed and keeps going", async () => {
		const results = await runSteps(
			[step("a", [], new Error("boom secret")), step("b", [], { state: "already", detail: "ok" })],
			"apply",
			undefined,
			(error) => (error as Error).message.replace("secret", "[redacted]"),
		);
		expect(results[0]?.outcome).toEqual({ state: "failed", error: "boom [redacted]" });
		expect(results[1]?.outcome.state).toBe("already");
		expect(exitCodeFor(results)).toBe(1);
	});

	it("refuses a dependency on an unknown or later step", async () => {
		await expect(
			runSteps([step("a", ["zzz"], { state: "already", detail: "" })], "apply"),
		).rejects.toThrow(/unknown\/later step zzz/);
	});

	it("settle: todo is would_do in a dry run and applies otherwise", async () => {
		const todo: Decision<number> = { state: "todo", action: "do it", plan: 7 };
		let applied = 0;
		const apply = async (plan: number): Promise<OnboardOutcome> => {
			applied = plan;
			return { state: "done", detail: "did it" };
		};
		expect(await settle(todo, "dry-run", apply)).toEqual({ state: "would_do", action: "do it" });
		expect(applied).toBe(0);
		expect(await settle(todo, "apply", apply)).toEqual({ state: "done", detail: "did it" });
		expect(applied).toBe(7);
		expect(await settle({ state: "already", detail: "a" }, "apply", apply)).toEqual({
			state: "already",
			detail: "a",
		});
	});

	it("exit code is 0 for already/would_do/done and 1 for blocked/failed/skipped", () => {
		const r = (outcome: OnboardOutcome) => [{ id: "x", outcome }];
		expect(exitCodeFor(r({ state: "would_do", action: "" }))).toBe(0);
		expect(exitCodeFor(r({ state: "done", detail: "" }))).toBe(0);
		expect(exitCodeFor(r({ state: "skipped", reason: "" }))).toBe(1);
		expect(exitCodeFor(r({ state: "blocked", reason: "", remedy: "" }))).toBe(1);
	});

	it("formats a remedy line under blocked", () => {
		const lines = formatResults([
			{ id: "domain", outcome: { state: "blocked", reason: "no zone id", remedy: "add zoneId" } },
		]);
		expect(lines).toEqual(["  blocked   domain  no zone id", "                    -> add zoneId"]);
	});
});

// --- Email Sending ---------------------------------------------------------

const SPF = "v=spf1 include:_spf.mx.cloudflare.net ~all";
const PROVIDER: ParsedDnsRecord[] = [
	{
		type: "MX",
		name: "cf-bounce.send.example.com",
		content: "route1.mx.cloudflare.net.",
		priority: 51,
	},
	{
		type: "MX",
		name: "cf-bounce.send.example.com",
		content: "route2.mx.cloudflare.net.",
		priority: 99,
	},
	{ type: "TXT", name: "cf-bounce.send.example.com", content: SPF },
	{
		type: "TXT",
		name: "cf-bounce._domainkey.send.example.com",
		content: "v=DKIM1; h=sha256; k=rsa; p=AAAA",
	},
	{ type: "TXT", name: "_dmarc.send.example.com", content: "v=DMARC1; p=reject;" },
];
const LIVE: FeedbackSubscriptionVerdict = { state: "live", subscriptionIds: ["s1"] };

function completeObservation(): SendingObservation {
	return {
		enabled: true,
		providerRecords: PROVIDER,
		spf: [SPF],
		dkim: ['"v=DKIM1; h=sha256; k=rsa; " "p=AAAA"'],
		mx: [
			{ priority: 51, exchange: "route1.mx.cloudflare.net" },
			{ priority: 99, exchange: "route2.mx.cloudflare.net" },
		],
		dmarc: ["v=DMARC1; p=none; adkim=r; aspf=r; rua=mailto:dmarc@example.com"],
		feedback: { verdict: LIVE, queue: "events" },
		tokenPresent: false,
	};
}

function decideSend(observed: SendingObservation, index = 0) {
	const m = resolved();
	const entry = m.sending[index];
	if (!entry) throw new Error("no entry");
	return decideSendingTarget({ env: "dev", entry, dmarc: m.dmarc, observed });
}

describe("decideSendingTarget", () => {
	it("is already when everything setup:sending would write is published", () => {
		const decision = decideSend(completeObservation());
		expect(decision.state).toBe("already");
		expect(decision.state === "already" && decision.detail).toBe(
			"send.example.com: enabled, SPF, DKIM, 2 MX, DMARC p=none rua=dmarc@example.com, 6 events.",
		);
	});

	it("fresh name without a token is blocked (enabling alone leaves a p=reject nobody chose)", () => {
		const decision = decideSend({
			...completeObservation(),
			enabled: false,
			providerRecords: null,
			spf: [],
			dkim: null,
			mx: [],
			dmarc: [],
			feedback: { verdict: { state: "absent" }, queue: "events" },
		});
		expect(decision.state).toBe("blocked");
		expect(decision.state === "blocked" && decision.remedy).toMatch(/CLOUDFLARE_API_TOKEN/);
	});

	it("fresh name with a token is one setup:sending --apply", () => {
		const decision = decideSend({
			...completeObservation(),
			enabled: false,
			providerRecords: null,
			spf: [],
			dkim: null,
			mx: [],
			dmarc: [],
			feedback: { verdict: { state: "absent" }, queue: "events" },
			tokenPresent: true,
		});
		expect(decision.state).toBe("todo");
		if (decision.state !== "todo") return;
		expect(decision.plan.args).toEqual([
			"setup:sending",
			"--env",
			"dev",
			"--domain",
			"example.com",
			"--subdomain",
			"send",
			"--dmarc-policy",
			"none",
			"--dmarc-rua",
			"dmarc@example.com",
			"--apply",
		]);
		expect(decision.plan.missing.join("\n")).toMatch(/not enabled/);
		expect(decision.plan.missing.join("\n")).toMatch(/no Email Sending event subscription/);
	});

	it("partial: only the subscription missing needs no token", () => {
		const decision = decideSend({
			...completeObservation(),
			feedback: {
				verdict: {
					state: "partial_events",
					subscriptionIds: ["s1"],
					missingEvents: ["message.failed"],
				},
				queue: "events",
			},
		});
		expect(decision.state).toBe("todo");
		expect(decision.state === "todo" && decision.plan.missing).toHaveLength(1);
	});

	it("names the apex in a DMARC change and uses --apex", () => {
		const observed = completeObservation();
		const apexProvider = PROVIDER.map((r) => ({
			...r,
			name: r.name.replace("send.example.com", "example.com"),
		}));
		const decision = decideSend(
			{
				...observed,
				providerRecords: apexProvider,
				dmarc: ["v=DMARC1; p=reject;"],
				tokenPresent: true,
			},
			1,
		);
		expect(decision.state).toBe("todo");
		if (decision.state !== "todo") return;
		expect(decision.plan.args).toContain("--apex");
		expect(decision.action).toMatch(/APEX: governs every sender using @example\.com/);
	});

	it("DMARC with two records is not already, even if one matches", () => {
		const observed = completeObservation();
		const decision = decideSend({
			...observed,
			dmarc: [...(observed.dmarc ?? []), "v=DMARC1; p=reject;"],
		});
		expect(decision.state).toBe("blocked");
		expect(decision.state === "blocked" && decision.reason).toMatch(/DMARC/);
	});

	it("a subscription pointed at another queue is blocked, never repointed", () => {
		const decision = decideSend({
			...completeObservation(),
			feedback: {
				verdict: { state: "wrong_queue", subscriptionIds: ["s9"], queueIds: ["q2"] },
				queue: "events",
			},
		});
		expect(decision.state).toBe("blocked");
		expect(decision.state === "blocked" && decision.remedy).toMatch(/--id s9/);
	});

	it("an unreadable DNS answer is blocked, not assumed", () => {
		const decision = decideSend({ ...completeObservation(), spf: null });
		expect(decision.state).toBe("blocked");
		expect(decision.state === "blocked" && decision.reason).toMatch(/could not read TXT cf-bounce/);
	});

	it("a missing MX priority is a DNS gap", () => {
		const decision = decideSend({
			...completeObservation(),
			mx: [{ priority: 51, exchange: "route1.mx.cloudflare.net" }],
			tokenPresent: true,
		});
		expect(decision.state === "todo" && decision.plan.missing.join()).toMatch(
			/route2\.mx\.cloudflare\.net \(99\)/,
		);
	});

	it("setupSendingArgs passes alignment only when set", () => {
		const m = resolved();
		const target = m.sending[0]!.target;
		expect(
			setupSendingArgs({
				env: undefined,
				target,
				dmarc: { policy: "reject", alignment: "strict" },
				apply: false,
			}),
		).toEqual([
			"setup:sending",
			"--domain",
			"example.com",
			"--subdomain",
			"send",
			"--dmarc-policy",
			"reject",
			"--dmarc-alignment",
			"strict",
		]);
	});
});

// --- Config + deployed -------------------------------------------------------

describe("sending config (shared with setup:sending)", () => {
	const tracked = {
		name: "reccado",
		env: {
			dev: {
				name: "reccado-dev",
				vars: { MAILBOX_JURISDICTION: "eu" },
				send_email: [{ name: "EMAIL" }],
			},
		},
	};

	it("adds the names as a union, keeps an existing default sender, leaves an unbounded list unbounded", () => {
		const generated = structuredClone(tracked) as typeof tracked & {
			env: { dev: { vars: Record<string, string> } };
		};
		generated.env.dev.vars = {
			...generated.env.dev.vars,
			MAIL_FROM_ADDRESS: "noreply@send.other.dev",
			MAIL_SENDING_DOMAINS: "send.other.dev",
		};
		const result = planSendingConfigUpdate({
			tracked,
			generated,
			env: "dev",
			addDomains: ["send.example.com", "example.com"],
			fromAddress: "hello@send.example.com",
			addSenders: ["support@example.com"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.sendingDomains).toEqual([
			"example.com",
			"send.example.com",
			"send.other.dev",
		]);
		expect(result.value.nextFrom).toBe("noreply@send.other.dev");
		expect(result.value.fromAddressPreserved).toBe(true);
		expect(result.value.emailBinding).toBe("unbounded");
		expect(result.value.config.env?.dev?.send_email?.[0]?.allowed_sender_addresses).toBeUndefined();
		expect(result.value.changed).toBe(true);
		const decision = decideSendingConfig(result.value, "wrangler.generated.dev.json");
		expect(decision.state === "todo" && decision.action).toMatch(
			/MAIL_SENDING_DOMAINS \+= example\.com, send\.example\.com/,
		);
		// Inputs are not mutated.
		expect(generated.env.dev.vars.MAIL_SENDING_DOMAINS).toBe("send.other.dev");
	});

	it("is already when the generated file already ships the names", () => {
		const generated = structuredClone(tracked) as typeof tracked & {
			env: { dev: { vars: Record<string, string> } };
		};
		generated.env.dev.vars = {
			...generated.env.dev.vars,
			MAIL_FROM_ADDRESS: "hello@send.example.com",
			MAIL_SENDING_DOMAINS: "example.com,send.example.com",
		};
		const result = planSendingConfigUpdate({
			tracked,
			generated,
			env: "dev",
			addDomains: ["send.example.com"],
			fromAddress: "hello@send.example.com",
			addSenders: [],
		});
		expect(result.ok && result.value.changed).toBe(false);
		expect(result.ok && decideSendingConfig(result.value, "g.json").state).toBe("already");
	});

	it("widens a bounded allow-list and sets a first default sender", () => {
		const bounded = structuredClone(tracked);
		(bounded.env.dev.send_email[0] as Record<string, unknown>).allowed_sender_addresses = [
			"a@x.com",
		];
		const result = planSendingConfigUpdate({
			tracked: bounded,
			generated: undefined,
			env: "dev",
			addDomains: ["send.example.com"],
			fromAddress: "hello@send.example.com",
			addSenders: ["support@example.com"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.allowedSenders).toEqual(["a@x.com", "support@example.com"]);
		expect(result.value.nextFrom).toBe("hello@send.example.com");
		expect(result.value.changed).toBe(true);
	});

	it("reports a missing env block", () => {
		const result = planSendingConfigUpdate({
			tracked,
			generated: undefined,
			env: "staging",
			addDomains: [],
			fromAddress: "a@b.co",
			addSenders: [],
		});
		expect(result.ok).toBe(false);
	});

	it("deployed: blocked with the deploy command when the live version lacks a name", () => {
		const decision = decideDeployedDomains({
			env: "dev",
			worker: "reccado-dev",
			targets: ["send.example.com", "example.com"],
			live: [{ versionId: "6000c3a9-6c0d", domains: ["send.example.com"] }],
		});
		expect(decision.state).toBe("blocked");
		expect(decision.state === "blocked" && decision.reason).toMatch(
			/deploy required: .*lacks example\.com/,
		);
		expect(decision.state === "blocked" && decision.remedy).toBe(
			"pnpm run deploy:dev --dry-run   # review the overlay; then: pnpm run deploy:dev",
		);
		expect(
			decideDeployedDomains({
				env: "dev",
				worker: "w",
				targets: ["a.com"],
				live: [{ versionId: "v1", domains: ["a.com", "b.com"] }],
			}).state,
		).toBe("already");
		expect(
			decideDeployedDomains({ env: undefined, worker: "w", targets: ["a.com"], live: null }).state,
		).toBe("blocked");
	});

	it("parses wrangler deployments status and versions view JSON", () => {
		expect(
			parseDeploymentStatus(
				'noise\n{"id":"d","versions":[{"version_id":"v1","percentage":100},{"version_id":"v0","percentage":0}]}',
			),
		).toEqual(["v1"]);
		expect(parseDeploymentStatus("not json")).toBeNull();
		expect(
			parseVersionVars(
				JSON.stringify({
					resources: {
						bindings: [
							{
								type: "plain_text",
								name: "MAIL_SENDING_DOMAINS",
								text: "send.example.com,example.com",
							},
							{ type: "d1", name: "INDEX_DB" },
						],
					},
				}),
			),
		).toEqual({ MAIL_SENDING_DOMAINS: "send.example.com,example.com" });
		expect(parseVersionVars('{"resources":{}}')).toBeNull();
	});
});

// --- Routing -------------------------------------------------------------------

const RULES_OUTPUT = `
 ⛅️ wrangler 4.128.0
Rule: 234290dc4c61417aaee662d86d42956a
  Name:     support -> reccado
  Enabled:  true
  Matchers: to:support@example.com
  Actions:  worker:reccado-dev
  Priority: 0

Rule: c40dff32fafc4a7cb4954ea622819bce
  Name:     privacy -> forward
  Enabled:  true
  Matchers: to:privacy@example.com
  Actions:  forward:someone@else.com,other@else.com
  Priority: 0

Rule: 221bc693a5da4fa68e7112ae94c61672
  Name:     (none)
  Enabled:  false
  Matchers: to:dmarc@example.com
  Actions:  worker:reccado-dev
  Priority: 3


Catch-all rule: enabled, action: worker:reccado-dev
  (use \`wrangler email routing rules get catch-all\` to view details)
`;

describe("routing", () => {
	const { rules, catchAll } = parseRoutingRulesList(RULES_OUTPUT);

	it("parses wrangler's rules list, including the catch-all line", () => {
		expect(rules).toHaveLength(3);
		expect(rules[0]).toEqual({
			id: "234290dc4c61417aaee662d86d42956a",
			name: "support -> reccado",
			enabled: true,
			matchers: [{ field: "to", value: "support@example.com" }],
			actions: [{ type: "worker", values: ["reccado-dev"] }],
			priority: 0,
		});
		expect(rules[1]?.actions).toEqual([
			{ type: "forward", values: ["someone@else.com", "other@else.com"] },
		]);
		expect(rules[2]?.name).toBe("");
		expect(catchAll).toEqual({ enabled: true, action: "worker:reccado-dev" });
		expect(parseRoutingRulesList("No routing rules found.").rules).toEqual([]);
	});

	it("an exact enabled rule to the worker is already", () => {
		const d = decideRoutingRule({
			zone: "example.com",
			address: "support@example.com",
			worker: "reccado-dev",
			rules,
		});
		expect(d.state).toBe("already");
	});

	it("a rule with the same matcher but another action is blocked, never overwritten", () => {
		const d = decideRoutingRule({
			zone: "example.com",
			address: "privacy@example.com",
			worker: "reccado-dev",
			rules,
		});
		expect(d.state).toBe("blocked");
		expect(d.state === "blocked" && d.reason).toMatch(/forward:someone@else\.com/);
	});

	it("a disabled rule for the address is blocked too", () => {
		const d = decideRoutingRule({
			zone: "example.com",
			address: "dmarc@example.com",
			worker: "reccado-dev",
			rules,
		});
		expect(d.state).toBe("blocked");
		expect(d.state === "blocked" && d.reason).toMatch(/disabled/);
	});

	it("a missing address creates exactly one literal rule; the catch-all does not count", () => {
		const d = decideRoutingRule({
			zone: "example.com",
			address: "new@example.com",
			worker: "reccado-dev",
			rules,
		});
		expect(d.state).toBe("todo");
		expect(d.state === "todo" && d.plan.args).toEqual([
			"email",
			"routing",
			"rules",
			"create",
			"example.com",
			"--name",
			"new -> reccado-dev",
			"--match-type",
			"literal",
			"--match-field",
			"to",
			"--match-value",
			"new@example.com",
			"--action-type",
			"worker",
			"--action-value",
			"reccado-dev",
		]);
	});

	it("an unreadable rules list is blocked", () => {
		expect(
			decideRoutingRule({ zone: "example.com", address: "a@example.com", worker: "w", rules: null })
				.state,
		).toBe("blocked");
	});

	it("routing settings: enabled+ready is already, disabled is todo, unverified DNS is blocked", () => {
		const ready = parseRoutingSettings(
			"Email Routing for example.com:\n  Enabled:  true\n  Status:   ready\n",
		);
		expect(ready).toEqual({ enabled: true, status: "ready" });
		expect(decideRoutingEnabled("example.com", ready).state).toBe("already");
		expect(decideRoutingEnabled("example.com", { enabled: false, status: null }).state).toBe(
			"todo",
		);
		expect(
			decideRoutingEnabled("example.com", { enabled: true, status: "unconfigured" }).state,
		).toBe("blocked");
		expect(decideRoutingEnabled("example.com", null).state).toBe("blocked");
		expect(parseRoutingSettings("garbage")).toBeNull();
	});
});

// --- Control plane -------------------------------------------------------------

const MAILBOX: MailboxRowLike = {
	mailbox_id: "mbx_1",
	primary_address: "support@example.com",
	display_name: "Example",
	status: "active",
	owner_email: "owner@example.org",
};
const PRIMARY_ALIAS: AliasRowLike = {
	alias_address: "support@example.com",
	mailbox_id: "mbx_1",
	status: "active",
};

describe("control-plane decisions", () => {
	it("domain: registered is already (and cross-checks the zone id), missing needs a zone id", () => {
		const rows = [{ id: "d1", domain: "example.com", zone_id: "z1", status: "active" }];
		expect(decideDomain({ zone: "example.com", domains: rows, zoneId: "z1" }).state).toBe(
			"already",
		);
		expect(decideDomain({ zone: "example.com", domains: rows, zoneId: "z2" }).state).toBe(
			"blocked",
		);
		expect(decideDomain({ zone: "example.com", domains: [], zoneId: undefined }).state).toBe(
			"blocked",
		);
		const todo = decideDomain({ zone: "example.com", domains: [], zoneId: "z1" });
		expect(todo.state === "todo" && todo.plan).toEqual({ zoneId: "z1" });
		expect(
			decideDomain({
				zone: "example.com",
				domains: [{ ...rows[0]!, status: "disabled" }],
				zoneId: "z1",
			}).state,
		).toBe("blocked");
	});

	it("mailbox: fresh is a create, complete is already", () => {
		const fresh = decideMailbox({
			address: "support@example.com",
			displayName: "Example",
			mailboxes: [],
			aliases: [],
			sessionEmail: "owner@example.org",
		});
		expect(fresh.state === "todo" && fresh.plan).toEqual({ kind: "create" });
		const done = decideMailbox({
			address: "support@example.com",
			displayName: "Example",
			mailboxes: [MAILBOX],
			aliases: [PRIMARY_ALIAS],
			sessionEmail: "owner@example.org",
		});
		expect(done.state).toBe("already");
	});

	it("mailbox: partial state converges (missing primary alias, stale display name)", () => {
		const d = decideMailbox({
			address: "support@example.com",
			displayName: "Example Inc",
			mailboxes: [MAILBOX],
			aliases: [],
			sessionEmail: "owner@example.org",
		});
		expect(d.state === "todo" && d.plan).toEqual({
			kind: "converge",
			mailboxId: "mbx_1",
			repostForPrimaryAlias: true,
			displayName: "Example Inc",
		});
	});

	it("mailbox: another owner or a disabled mailbox is blocked", () => {
		expect(
			decideMailbox({
				address: "support@example.com",
				mailboxes: [MAILBOX],
				aliases: [PRIMARY_ALIAS],
				sessionEmail: "someone@else.org",
			}).state,
		).toBe("blocked");
		expect(
			decideMailbox({
				address: "support@example.com",
				mailboxes: [{ ...MAILBOX, status: "disabled" }],
				aliases: [],
				sessionEmail: "owner@example.org",
			}).state,
		).toBe("blocked");
	});

	it("alias: missing is a create, ours is already, someone else's is blocked", () => {
		const aliases: AliasRowLike[] = [
			{ alias_address: "privacy@example.com", mailbox_id: "mbx_1", status: "active" },
			{ alias_address: "legal@example.com", mailbox_id: "mbx_2", status: "active" },
			{ alias_address: "old@example.com", mailbox_id: "mbx_1", status: "disabled" },
		];
		expect(decideAlias({ alias: "privacy@example.com", mailboxId: "mbx_1", aliases }).state).toBe(
			"already",
		);
		expect(decideAlias({ alias: "new@example.com", mailboxId: undefined, aliases }).state).toBe(
			"todo",
		);
		expect(decideAlias({ alias: "legal@example.com", mailboxId: "mbx_1", aliases }).state).toBe(
			"blocked",
		);
		expect(decideAlias({ alias: "old@example.com", mailboxId: "mbx_1", aliases }).state).toBe(
			"blocked",
		);
	});

	it("templates: diff against the active list; archived-on-server is blocked after sync", () => {
		const desired = [
			{ id: "a", subject: "A", body_text: "x" },
			{ id: "b", subject: "B" },
			{ id: "c", subject: "C", body_html: "<p>c</p>" },
		];
		const existing = [
			{ id: "a", subject: "A", body_text: "x", body_html: null },
			{ id: "b", subject: "B changed", body_text: null, body_html: null },
			{ id: "z", subject: "Z", body_text: null, body_html: null },
		];
		expect(diffTemplates(desired, existing, true)).toEqual({
			create: ["c"],
			update: ["b"],
			unchanged: ["a"],
			archive: ["z"],
		});
		expect(diffTemplates(desired, existing, false).archive).toEqual([]);
		const todo = decideTemplates({
			mailboxId: "mbx_1",
			file: "t.json",
			diff: diffTemplates(desired, existing, false),
			archiveMissing: false,
		});
		expect(todo.state === "todo" && todo.action).toMatch(/create c; update b; 1 unchanged/);
		expect(
			decideTemplates({
				mailboxId: "mbx_1",
				file: "t.json",
				diff: diffTemplates(desired.slice(0, 1), existing, false),
				archiveMissing: false,
			}).state,
		).toBe("already");
		expect(
			interpretTemplateSync([
				{ id: "a", outcome: "unchanged" },
				{ id: "c", outcome: "created" },
			]),
		).toEqual({
			state: "done",
			detail: "templates synced: created 1, updated 0, unchanged 1, archived 0.",
		});
		expect(
			interpretTemplateSync([{ id: "c", outcome: "archived", reason: "already_archived" }]).state,
		).toBe("blocked");
	});

	it("endpoint shape", () => {
		expect(endpointFor("https://inbox.example.com", "mbx_1")).toBe(
			"https://inbox.example.com/v1/mailboxes/mbx_1/transactional/messages",
		);
	});
});

// --- Keys ------------------------------------------------------------------------

const BODY: KeyCreateBody = {
	environment: "live",
	sender: "hello@send.example.com",
	senderName: "Example",
	scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
	templateAllowlist: ["magic-link", "receipt"],
	recipientPolicy: "me@example.org,@example.com",
	quotaMax: 50,
};
const ACTIVE: ApiKeyEntry = {
	keyId: "k1",
	status: "active",
	environment: "live",
	sender: "hello@send.example.com",
	senderName: "Example",
	scopes: ["transactional:status", "transactional:send", "transactional:templates:use"],
	templateAllowlist: ["receipt", "magic-link"],
	recipientPolicy: "me@example.org,@example.com",
	quotaMax: 50,
};
const ENDPOINT = "https://inbox.example.com/v1/mailboxes/mbx_1/transactional/messages";

function keyDecision(overrides: Partial<Parameters<typeof decideKey>[0]>) {
	return decideKey({
		name: "preview",
		body: BODY,
		store: { kind: "present", itemId: "item1", keyId: "k1", endpoint: ENDPOINT },
		storeLabel: 'Personal/"Example key"',
		keys: [ACTIVE],
		mailboxId: "mbx_1",
		endpoint: ENDPOINT,
		...overrides,
	});
}

describe("key idempotency", () => {
	it("stored key id that is active and matches: already", () => {
		const d = keyDecision({});
		expect(d.state).toBe("already");
		expect(d.state === "already" && d.detail).toMatch(/key k1 is active/);
	});

	it("nothing stored yet: mint exactly one", () => {
		const d = keyDecision({ store: { kind: "absent" } });
		expect(d.state === "todo" && d.plan).toEqual({ kind: "mint" });
		expect(keyDecision({ store: { kind: "absent" }, keys: null, mailboxId: undefined }).state).toBe(
			"todo",
		);
	});

	it("no store configured: refused (a key that cannot be stored is a lost key)", () => {
		const d = keyDecision({ store: { kind: "none" } });
		expect(d.state).toBe("blocked");
		expect(d.state === "blocked" && d.reason).toMatch(/lost key/);
	});

	it("stored key revoked or missing: blocked with rotate/delete remedy, never a silent second key", () => {
		const revoked = keyDecision({ keys: [{ ...ACTIVE, status: "revoked" }] });
		expect(revoked.state).toBe("blocked");
		expect(revoked.state === "blocked" && revoked.remedy).toMatch(/op item delete item1/);
		const missing = keyDecision({ keys: [] });
		expect(missing.state).toBe("blocked");
		expect(missing.state === "blocked" && missing.reason).toMatch(/not a key of this mailbox/);
		const noMailbox = keyDecision({ keys: null, mailboxId: undefined });
		expect(noMailbox.state).toBe("blocked");
	});

	it("item without a key id, ambiguous titles, or op unavailable: blocked", () => {
		expect(keyDecision({ store: { kind: "present", itemId: "item1" } }).state).toBe("blocked");
		expect(keyDecision({ store: { kind: "ambiguous", itemIds: ["a", "b"] } }).state).toBe(
			"blocked",
		);
		expect(keyDecision({ store: { kind: "unavailable", reason: "locked" } }).state).toBe("blocked");
	});

	it("fields fixed at creation that drifted: blocked (rotation copies them)", () => {
		const d = keyDecision({
			keys: [{ ...ACTIVE, templateAllowlist: ["magic-link"], quotaMax: null }],
		});
		expect(d.state).toBe("blocked");
		expect(d.state === "blocked" && d.reason).toMatch(/templateAllowlist lacks receipt/);
		expect(d.state === "blocked" && d.reason).toMatch(/quotaMax none ≠ 50/);
	});

	it("sender name and endpoint drift are fixed in place", () => {
		const d = keyDecision({
			keys: [{ ...ACTIVE, senderName: null }],
			store: { kind: "present", itemId: "item1", keyId: "k1", endpoint: "https://old/x" },
		});
		expect(d.state === "todo" && d.plan).toEqual({
			kind: "fix",
			itemId: "item1",
			keyId: "k1",
			senderName: "Example",
			endpoint: ENDPOINT,
		});
	});

	it("diffKey compares scopes and allowlists as sets", () => {
		expect(diffKey(BODY, ACTIVE)).toEqual({ senderName: false, fixed: [] });
		expect(
			diffKey({ ...BODY, recipientPolicy: undefined }, { ...ACTIVE, recipientPolicy: null }).fixed,
		).toEqual([]);
	});

	it("1Password helpers: exact-title match, field parsing, item shape", () => {
		const list = JSON.stringify([
			{ id: "i1", title: "Example key" },
			{ id: "i2", title: "Example key (old)" },
		]);
		expect(findItemsByTitle(list, "Example key")).toEqual(["i1"]);
		expect(parseOpFields('{"label":"key id","value":"k1","type":"STRING"}')).toEqual({
			"key id": "k1",
		});
		expect(
			parseOpFields(
				'[{"label":"key id","value":"k1"},{"label":"RECCADO_ENDPOINT","value":"https://e"}]',
			),
		).toEqual({ "key id": "k1", RECCADO_ENDPOINT: "https://e" });
		const item = buildOnePasswordItem({
			title: "T",
			plaintextKey: "rk_live_secret",
			endpoint: ENDPOINT,
			keyId: "k1",
			notes: "n",
		});
		expect(item.category).toBe("API_CREDENTIAL");
		const fields = item.fields as Array<{ label: string; type: string; value: string }>;
		expect(fields.find((f) => f.label === "credential")).toMatchObject({
			type: "CONCEALED",
			value: "rk_live_secret",
		});
		expect(fields.find((f) => f.label === "key id")?.value).toBe("k1");
		expect(fields.find((f) => f.label === "RECCADO_ENDPOINT")?.value).toBe(ENDPOINT);
	});
});

// --- Whole-plan computation --------------------------------------------------------

type World = {
	sending: SendingObservation;
	mailboxes: MailboxRowLike[];
	aliases: AliasRowLike[];
	rules: ReturnType<typeof parseRoutingRulesList>["rules"];
	templates: Array<{
		id: string;
		subject: string;
		body_text: string | null;
		body_html: string | null;
	}>;
	keys: ApiKeyEntry[] | null;
	store: Parameters<typeof decideKey>[0]["store"];
};

/** The same decide-then-settle wiring scripts/onboard.ts uses, over a static world. */
async function plan(world: World, mode: Mode) {
	const m = resolved();
	const templates = [
		{ id: "magic-link", subject: "Sign in", body_text: "{{url}}" },
		{ id: "receipt", subject: "Receipt", body_text: "{{total}}" },
	];
	const body = resolveKeyBodies(
		m.keys,
		templates.map((t) => t.id),
	);
	if (!body.ok) throw new Error(body.errors.join());
	const mailboxId = world.mailboxes.find(
		(x) => x.primary_address === m.mailbox.address,
	)?.mailbox_id;
	const applied = async () => ({ state: "done", detail: "applied" }) as OnboardOutcome;
	const steps: StepSpec[] = [
		{
			id: "sending:send.example.com",
			deps: [],
			run: async () => settle(decideSend(world.sending), mode, applied),
		},
		{
			id: "routing:support@example.com",
			deps: [],
			run: async () =>
				settle(
					decideRoutingRule({
						zone: m.zone,
						address: m.mailbox.address,
						worker: "reccado-dev",
						rules: world.rules,
					}),
					mode,
					applied,
				),
		},
		{
			id: "mailbox",
			deps: [],
			run: async () =>
				settle(
					decideMailbox({
						address: m.mailbox.address,
						displayName: m.mailbox.displayName,
						mailboxes: world.mailboxes,
						aliases: world.aliases,
						sessionEmail: "owner@example.org",
					}),
					mode,
					applied,
				),
		},
		...m.mailbox.aliases.map((alias) => ({
			id: `alias:${alias}`,
			deps: ["mailbox"],
			run: async () =>
				settle(decideAlias({ alias, mailboxId, aliases: world.aliases }), mode, applied),
		})),
		{
			id: "templates",
			deps: ["mailbox"],
			run: async () =>
				settle(
					decideTemplates({
						mailboxId,
						file: "t.json",
						diff: diffTemplates(templates, world.templates, false),
						archiveMissing: false,
					}),
					mode,
					applied,
				),
		},
		{
			id: "key:preview",
			deps: ["mailbox", "templates", "sending:send.example.com"],
			run: async () =>
				settle(
					decideKey({
						name: "preview",
						body: body.value.get("preview")!,
						store: world.store,
						keys: world.keys,
						mailboxId,
						endpoint: mailboxId ? endpointFor("https://inbox.example.com", mailboxId) : undefined,
					}),
					mode,
					applied,
				),
		},
	];
	return (await runSteps(steps, mode)).map((r) => [r.id, r.outcome.state]);
}

const COMPLETE: World = {
	sending: completeObservation(),
	mailboxes: [{ ...MAILBOX, owner_email: "owner@example.org" }],
	aliases: [
		PRIMARY_ALIAS,
		{ alias_address: "privacy@example.com", mailbox_id: "mbx_1", status: "active" },
		{ alias_address: "dmarc@example.com", mailbox_id: "mbx_1", status: "active" },
	],
	rules: parseRoutingRulesList(RULES_OUTPUT).rules,
	templates: [
		{ id: "magic-link", subject: "Sign in", body_text: "{{url}}", body_html: null },
		{ id: "receipt", subject: "Receipt", body_text: "{{total}}", body_html: null },
	],
	keys: [ACTIVE],
	store: {
		kind: "present",
		itemId: "item1",
		keyId: "k1",
		endpoint: "https://inbox.example.com/v1/mailboxes/mbx_1/transactional/messages",
	},
};

describe("plan computation from observed state", () => {
	it("complete: every step already (a second --apply changes nothing)", async () => {
		const states = await plan(COMPLETE, "apply");
		expect(states.every(([, state]) => state === "already")).toBe(true);
		expect(await plan(COMPLETE, "dry-run")).toEqual(states);
	});

	it("fresh: a dry run is all would_do; nothing applies", async () => {
		const fresh: World = {
			sending: {
				...completeObservation(),
				enabled: false,
				providerRecords: null,
				spf: [],
				dkim: null,
				mx: [],
				dmarc: [],
				feedback: { verdict: { state: "absent" }, queue: "events" },
				tokenPresent: true,
			},
			mailboxes: [],
			aliases: [],
			rules: [],
			templates: [],
			keys: null,
			store: { kind: "absent" },
		};
		expect(await plan(fresh, "dry-run")).toEqual([
			["sending:send.example.com", "would_do"],
			["routing:support@example.com", "would_do"],
			["mailbox", "would_do"],
			["alias:privacy@example.com", "would_do"],
			["alias:dmarc@example.com", "would_do"],
			["templates", "would_do"],
			["key:preview", "would_do"],
		]);
	});

	it("partial: a blocked sending name skips only the key that sends from it", async () => {
		const partial: World = {
			...COMPLETE,
			sending: { ...completeObservation(), spf: [], tokenPresent: false },
			aliases: COMPLETE.aliases.filter((a) => a.alias_address !== "dmarc@example.com"),
			templates: COMPLETE.templates.slice(0, 1),
		};
		expect(await plan(partial, "apply")).toEqual([
			["sending:send.example.com", "blocked"],
			["routing:support@example.com", "already"],
			["mailbox", "already"],
			["alias:privacy@example.com", "already"],
			["alias:dmarc@example.com", "done"],
			["templates", "done"],
			["key:preview", "skipped"],
		]);
	});
});

describe("parseDohMxAnswer", () => {
	it("parses priority + exchange and treats NXDOMAIN as empty", () => {
		expect(
			parseDohMxAnswer({
				Status: 0,
				Answer: [
					{ type: 15, data: "51 route1.mx.cloudflare.net." },
					{ type: 5, data: "cname.example.com." },
				],
			}),
		).toEqual([{ priority: 51, exchange: "route1.mx.cloudflare.net" }]);
		expect(parseDohMxAnswer({ Status: 3 })).toEqual([]);
		expect(parseDohMxAnswer({ Status: 2 })).toBeNull();
		expect(parseDohMxAnswer(null)).toBeNull();
	});
});
