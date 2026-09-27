/**
 * The pure half of `pnpm onboard`: the manifest schema, the per-step decisions
 * computed from observed state, dependency skipping, and the report.
 *
 * No node:* imports and no subprocesses, so all of it runs in the Workers Vitest
 * pool (same split as ./operator-session-core.ts). The IO — wrangler, public DNS,
 * the control plane, 1Password, the generated config file — lives in
 * scripts/onboard.ts, which observes, calls a `decide*` function here, and only
 * then (with --apply) acts.
 *
 * Outcome vocabulary is src/lib/provision.ts's — `already | done | skipped |
 * blocked | failed`, every `blocked` carrying a remedy — plus `would_do`, which is
 * what a dry run says instead of `done`.
 */
import { z } from "zod";
import {
	createTransactionalApiKeySchema,
	syncTransactionalTemplatesSchema,
	transactionalApiKeyScopeSchema,
} from "../../src/api/schemas";
import { normalizeTxtContent } from "../../src/lib/dns-gate";
import type { StepOutcome } from "../../src/lib/provision";
import { validateRecipientPolicy } from "../../src/lib/transactional-send";
import { parseDmarcTags } from "./dmarc";
import { canonicalHost, type MxAnswer } from "./dns-lookup";
import { describeFeedbackVerdict, type FeedbackSubscriptionVerdict } from "./event-subscriptions";
import {
	literalRoutingRuleArgs,
	type RoutingRule,
	type RoutingSettings,
	ruleDeliversToWorker,
	ruleMatchesAddress,
} from "./routing";
import type { SendingConfigUpdate } from "./sending-config";
import {
	type DmarcPlan,
	normalizeZone,
	type ParsedDnsRecord,
	resolveDmarcPlan,
	resolveSendingTarget,
	type SendingTarget,
	SPF_VALUE,
	selectProviderRecords,
} from "./sending-plan";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const email = z
	.string()
	.trim()
	.email()
	.transform((value) => value.toLowerCase());

const dmarcSchema = z
	.object({
		policy: z.enum(["none", "quarantine", "reject"]),
		rua: email.optional(),
		alignment: z.enum(["relaxed", "strict"]).optional(),
	})
	.strict();

const onePasswordSchema = z
	.object({
		vault: z.string().trim().min(1),
		title: z.string().trim().min(1),
		/** Extra text for the item's notes. Never put a secret here. */
		notes: z.string().optional(),
	})
	.strict();

const keySchema = z
	.object({
		/** Manifest-local handle. The server has no key names; this only labels the step. */
		name: z
			.string()
			.trim()
			.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/, "use letters, digits, - and _ (max 48)"),
		environment: z.enum(["live", "test"]).default("live"),
		sender: email,
		senderName: z.string().optional(),
		scopes: z.array(transactionalApiKeyScopeSchema).min(1),
		/** `"all"` = every id in the templates file; or an explicit list of ids from it. */
		templates: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]).optional(),
		recipientPolicy: z.string().optional(),
		quotaMax: z.number().int().positive().optional(),
		store: z.object({ onePassword: onePasswordSchema }).strict().optional(),
	})
	.strict();

export const onboardManifestSchema = z
	.object({
		zone: z.string().min(1),
		/** Optional; otherwise discovered (event subscriptions in the zone, or CLOUDFLARE_API_TOKEN). */
		zoneId: z
			.string()
			.trim()
			.regex(/^[0-9a-f]{32}$/, "a 32-character hex Cloudflare zone id")
			.optional(),
		sending: z
			.object({
				/** Label under the zone (default `send`); `false` provisions no subdomain. */
				subdomain: z.union([z.string().min(1), z.literal(false)]).optional(),
				/** Also provision the zone apex, so the mailbox replies as itself. */
				apex: z.boolean().optional(),
				/** Applied to every provisioned name. Required: the apex has no safe default. */
				dmarc: dmarcSchema,
			})
			.strict(),
		mailbox: z
			.object({
				address: email,
				displayName: z.string().trim().min(1).max(120).optional(),
				aliases: z.array(email).optional(),
			})
			.strict(),
		templates: z
			.object({
				/** Path to a JSON array of {id, subject, body_text?, body_html?} (or {templates: [...]}); relative to the manifest. */
				file: z.string().min(1),
				archiveMissing: z.boolean().optional(),
			})
			.strict()
			.optional(),
		keys: z.array(keySchema).optional(),
		/**
		 * The mailbox's forum topic in the bound Telegram chat. `topicName` creates
		 * one under that name (independent of mailbox.displayName, which is the From
		 * name of its replies); `adoptThreadId` maps an existing topic instead. An
		 * empty object creates one named after the mailbox.
		 */
		telegram: z
			.object({
				topicName: z.string().trim().min(1).max(128).optional(),
				adoptThreadId: z.number().int().positive().optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type OnboardManifestInput = z.input<typeof onboardManifestSchema>;
type ParsedManifest = z.output<typeof onboardManifestSchema>;
export type ManifestKey = ParsedManifest["keys"] extends Array<infer K> | undefined ? K : never;

export type SendingPlanEntry = {
	target: SendingTarget;
	dmarc: DmarcPlan;
};

export type ResolvedManifest = {
	zone: string;
	zoneId?: string;
	sending: SendingPlanEntry[];
	dmarc: {
		policy: "none" | "quarantine" | "reject";
		rua?: string;
		alignment?: "relaxed" | "strict";
	};
	mailbox: { address: string; displayName?: string; aliases: string[] };
	templates?: { file: string; archiveMissing: boolean };
	keys: ManifestKey[];
	telegram?: TelegramTopicSpec;
	warnings: string[];
};

export type TelegramTopicSpec = { topicName?: string; adoptThreadId?: number };

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function zodErrors(error: z.ZodError, prefix = ""): string[] {
	return error.issues.map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
		return `${prefix}${path}: ${issue.message}`;
	});
}

function domainOf(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1);
}

/**
 * Shape (zod) plus the cross-field rules the server would otherwise only reject
 * halfway through a run: addresses on the zone, a key sender on a name this
 * manifest provisions, a recipient policy the send path can parse.
 */
export function validateManifest(raw: unknown): Validation<ResolvedManifest> {
	const parsed = onboardManifestSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
	const m = parsed.data;
	const errors: string[] = [];
	const warnings: string[] = [];

	const zoneResult = normalizeZone(m.zone);
	if (!zoneResult.ok) return { ok: false, errors: [`zone: ${zoneResult.error}`] };
	const zone = zoneResult.value;

	const targets: SendingTarget[] = [];
	if (m.sending.subdomain !== false) {
		const sub = resolveSendingTarget({ zone, subdomain: m.sending.subdomain });
		if (sub.ok) targets.push(sub.value);
		else errors.push(`sending.subdomain: ${sub.error}`);
	}
	if (m.sending.apex) {
		const apex = resolveSendingTarget({ zone, apex: true });
		if (apex.ok && !targets.some((t) => t.sendingDomain === apex.value.sendingDomain)) {
			targets.push(apex.value);
		}
	}
	if (targets.length === 0 && errors.length === 0) {
		errors.push("sending: nothing to provision (subdomain is false and apex is not true).");
	}
	const sending: SendingPlanEntry[] = [];
	for (const target of targets) {
		const plan = resolveDmarcPlan({
			target,
			policy: m.sending.dmarc.policy,
			alignment: m.sending.dmarc.alignment,
			rua: m.sending.dmarc.rua,
		});
		if (!plan.ok) {
			errors.push(`sending.dmarc (${target.sendingDomain}): ${plan.error}`);
			continue;
		}
		sending.push({ target, dmarc: plan.value });
		// setup:sending's "this run will replace the apex DMARC" warning is about a
		// write; onboard only writes it when the step says so (and its action names
		// the apex), so only the unconditional warnings are surfaced up front.
		for (const warning of plan.value.warnings) {
			if (!warning.startsWith("APEX DMARC:")) warnings.push(`${target.sendingDomain}: ${warning}`);
		}
	}
	const sendingDomains = new Set(targets.map((t) => t.sendingDomain));

	const address = m.mailbox.address;
	if (domainOf(address) !== zone) {
		errors.push(
			`mailbox.address: ${address} is not on ${zone} (its routing rule lives in this zone).`,
		);
	}
	const aliases: string[] = [];
	for (const [index, alias] of (m.mailbox.aliases ?? []).entries()) {
		if (domainOf(alias) !== zone) {
			errors.push(`mailbox.aliases.${index}: ${alias} is not on ${zone}.`);
		} else if (alias === address) {
			errors.push(`mailbox.aliases.${index}: ${alias} is the mailbox address itself.`);
		} else if (aliases.includes(alias)) {
			errors.push(`mailbox.aliases.${index}: ${alias} is listed twice.`);
		} else {
			aliases.push(alias);
		}
	}

	const keys = m.keys ?? [];
	const names = new Set<string>();
	const stores = new Set<string>();
	for (const [index, key] of keys.entries()) {
		const at = `keys.${index} (${key.name})`;
		if (names.has(key.name)) errors.push(`${at}: duplicate key name.`);
		names.add(key.name);
		const senderDomain = domainOf(key.sender);
		if (!sendingDomains.has(senderDomain)) {
			errors.push(
				`${at}.sender: ${key.sender} is not on a sending domain this manifest provisions (${[...sendingDomains].join(", ") || "none"}).`,
			);
		}
		if (key.recipientPolicy !== undefined) {
			for (const issue of validateRecipientPolicy(key.recipientPolicy)) {
				errors.push(`${at}.recipientPolicy: rule ${JSON.stringify(issue.rule)}: ${issue.reason}`);
			}
		}
		if (key.templates !== undefined && !m.templates) {
			errors.push(`${at}.templates: needs a top-level "templates.file" to resolve against.`);
		}
		if (key.store) {
			const id = `${key.store.onePassword.vault}\u0000${key.store.onePassword.title}`;
			if (stores.has(id)) {
				errors.push(`${at}.store: another key already stores to this 1Password vault + title.`);
			}
			stores.add(id);
		}
		if (key.environment === "test") {
			warnings.push(`${at}: a test key cannot send (the production send path rejects test keys).`);
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			zone,
			...(m.zoneId ? { zoneId: m.zoneId } : {}),
			sending,
			dmarc: m.sending.dmarc,
			mailbox: {
				address,
				...(m.mailbox.displayName ? { displayName: m.mailbox.displayName } : {}),
				aliases,
			},
			...(m.templates
				? {
						templates: {
							file: m.templates.file,
							archiveMissing: m.templates.archiveMissing ?? false,
						},
					}
				: {}),
			keys,
			...(m.telegram ? { telegram: m.telegram } : {}),
			warnings,
		},
	};
}

export type TemplateInput = {
	id: string;
	subject: string;
	body_text?: string | null;
	body_html?: string | null;
};

/** A templates file: a bare array, or `{ templates: [...] }`. Validated with the sync route's schema. */
export function parseTemplatesFile(raw: unknown): Validation<TemplateInput[]> {
	const templates =
		Array.isArray(raw) || raw === null || typeof raw !== "object"
			? raw
			: (raw as { templates?: unknown }).templates;
	const parsed = syncTransactionalTemplatesSchema.safeParse({ templates });
	if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error, "templates file: ") };
	return { ok: true, value: parsed.data.templates };
}

export type KeyCreateBody = z.output<typeof createTransactionalApiKeySchema>;

/**
 * The exact `POST .../transactional/api-keys` body for each manifest key, run
 * through the route's own schema — so a body onboard would send is a body the
 * server accepts (send ⇒ templates:use, send ⇒ a non-empty allowlist, a
 * header-safe senderName, a parseable policy).
 */
export function resolveKeyBodies(
	keys: ManifestKey[],
	templateIds: string[] | null,
): Validation<Map<string, KeyCreateBody>> {
	const errors: string[] = [];
	const bodies = new Map<string, KeyCreateBody>();
	for (const key of keys) {
		let allowlist: string[] | undefined;
		if (key.templates === "all") {
			allowlist = [...(templateIds ?? [])];
			if (allowlist.length === 0) {
				errors.push(`keys (${key.name}).templates: "all" but the templates file is empty.`);
				continue;
			}
		} else if (Array.isArray(key.templates)) {
			const unknown = key.templates.filter((id) => !templateIds?.includes(id));
			if (unknown.length > 0) {
				errors.push(
					`keys (${key.name}).templates: not in the templates file: ${unknown.join(", ")}.`,
				);
				continue;
			}
			allowlist = [...key.templates];
		}
		const body = {
			environment: key.environment,
			sender: key.sender,
			...(key.senderName !== undefined ? { senderName: key.senderName } : {}),
			scopes: key.scopes,
			...(allowlist ? { templateAllowlist: allowlist } : {}),
			...(key.recipientPolicy !== undefined ? { recipientPolicy: key.recipientPolicy } : {}),
			...(key.quotaMax !== undefined ? { quotaMax: key.quotaMax } : {}),
		};
		const parsed = createTransactionalApiKeySchema.safeParse(body);
		if (!parsed.success) {
			errors.push(...zodErrors(parsed.error, `keys (${key.name}): `));
			continue;
		}
		bodies.set(key.name, parsed.data);
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: bodies };
}

// ---------------------------------------------------------------------------
// Steps, outcomes and dependency skipping
// ---------------------------------------------------------------------------

export type Mode = "dry-run" | "apply";

export type OnboardOutcome = StepOutcome | { state: "would_do"; action: string };

export type Decision<P = undefined> =
	| { state: "already"; detail: string }
	| { state: "todo"; action: string; plan: P }
	| { state: "blocked"; reason: string; remedy: string };

export type StepSpec = {
	id: string;
	deps: string[];
	run: () => Promise<OnboardOutcome>;
};

export type StepResult = { id: string; outcome: OnboardOutcome };

/** A dependency is met when it is in place, or (dry run) would be put in place by this run. */
export function dependencyMet(outcome: OnboardOutcome, mode: Mode): boolean {
	if (outcome.state === "already" || outcome.state === "done") return true;
	return mode === "dry-run" && outcome.state === "would_do";
}

/**
 * Runs steps in order. A step whose dependency did not succeed is `skipped`
 * (naming the dependency and its state) without running; nothing else is. A
 * throw inside a step becomes that step's `failed`, never an abort of the run.
 */
export async function runSteps(
	steps: StepSpec[],
	mode: Mode,
	onResult?: (result: StepResult) => void,
	describeError: (error: unknown) => string = (error) =>
		error instanceof Error ? error.message : String(error),
): Promise<StepResult[]> {
	const byId = new Map<string, StepResult>();
	const results: StepResult[] = [];
	for (const step of steps) {
		const unmet: string[] = [];
		for (const dep of step.deps) {
			const result = byId.get(dep);
			if (!result) throw new Error(`onboard: step ${step.id} depends on unknown/later step ${dep}`);
			if (!dependencyMet(result.outcome, mode)) unmet.push(`${dep} (${result.outcome.state})`);
		}
		let outcome: OnboardOutcome;
		if (unmet.length > 0) {
			outcome = { state: "skipped", reason: `needs ${unmet.join(", ")}` };
		} else {
			try {
				outcome = await step.run();
			} catch (error) {
				outcome = { state: "failed", error: describeError(error) };
			}
		}
		const result = { id: step.id, outcome };
		byId.set(step.id, result);
		results.push(result);
		onResult?.(result);
	}
	return results;
}

/**
 * Turns a decision into an outcome: `already`/`blocked` pass through, `todo`
 * becomes `would_do` in a dry run and runs `apply` otherwise.
 */
export async function settle<P>(
	decision: Decision<P>,
	mode: Mode,
	apply: (plan: P) => Promise<OnboardOutcome>,
): Promise<OnboardOutcome> {
	if (decision.state === "already") return { state: "already", detail: decision.detail };
	if (decision.state === "blocked") {
		return { state: "blocked", reason: decision.reason, remedy: decision.remedy };
	}
	if (mode === "dry-run") return { state: "would_do", action: decision.action };
	return apply(decision.plan);
}

export function isFailure(outcome: OnboardOutcome): boolean {
	return outcome.state === "failed" || outcome.state === "blocked" || outcome.state === "skipped";
}

// ---------------------------------------------------------------------------
// Commands the report prints
// ---------------------------------------------------------------------------

export function deployCommandFor(env: string | undefined): string {
	return env === "dev"
		? "pnpm run deploy:dev"
		: env
			? `pnpm exec tsx scripts/deploy.ts --env ${env}`
			: "pnpm run deploy";
}

/** `pnpm setup:sending ...` argv (without the leading `pnpm`) for one target. */
export function setupSendingArgs(opts: {
	env: string | undefined;
	target: SendingTarget;
	dmarc: ResolvedManifest["dmarc"];
	apply: boolean;
}): string[] {
	const { target, dmarc } = opts;
	return [
		"setup:sending",
		...(opts.env ? ["--env", opts.env] : []),
		"--domain",
		target.zone,
		...(target.isApex ? ["--apex"] : ["--subdomain", target.label ?? "send"]),
		"--dmarc-policy",
		dmarc.policy,
		...(dmarc.alignment ? ["--dmarc-alignment", dmarc.alignment] : []),
		...(dmarc.rua ? ["--dmarc-rua", dmarc.rua] : []),
		...(opts.apply ? ["--apply"] : []),
	];
}

export function endpointFor(origin: string, mailboxId: string): string {
	return `${origin}/v1/mailboxes/${mailboxId}/transactional/messages`;
}

// ---------------------------------------------------------------------------
// Decisions: Cloudflare Email Sending
// ---------------------------------------------------------------------------

export type SendingObservation = {
	/** From `wrangler email sending list`; null when it could not be read. */
	enabled: boolean | null;
	/** From `wrangler email sending dns get`; null when unavailable (e.g. not enabled). */
	providerRecords: ParsedDnsRecord[] | null;
	/** Public DNS (DoH) answers; null when the lookup failed. */
	spf: string[] | null;
	/** TXT at the provider's DKIM name; null when failed or not looked up. */
	dkim: string[] | null;
	mx: MxAnswer[] | null;
	dmarc: string[] | null;
	feedback:
		| { verdict: FeedbackSubscriptionVerdict; queue: string }
		| { error: string; fix: string };
	/** Whether CLOUDFLARE_API_TOKEN is set (setup:sending needs it for every DNS upsert). */
	tokenPresent: boolean;
};

export type SendingTodo = { args: string[]; missing: string[] };

/**
 * Whether one sending name is whole: enabled, SPF/DKIM/MX/DMARC published as
 * setup:sending would leave them, and all six lifecycle events reaching our
 * queue. "Already" is defined so that `setup:sending --apply` on it would change
 * nothing (same exact-match DMARC comparison it uses).
 */
export function decideSendingTarget(opts: {
	env: string | undefined;
	entry: SendingPlanEntry;
	dmarc: ResolvedManifest["dmarc"];
	observed: SendingObservation;
}): Decision<SendingTodo> {
	const { target } = opts.entry;
	const o = opts.observed;
	const sd = target.sendingDomain;
	const missing: string[] = [];
	const dns: string[] = [];
	const unknown: string[] = [];
	const verified: string[] = [];

	if (o.enabled === null) unknown.push(`whether Email Sending is enabled for ${sd}`);
	else if (!o.enabled) missing.push(`Email Sending is not enabled for ${sd}`);
	else verified.push("enabled");

	// SPF on the bounce name.
	if (o.spf === null) unknown.push(`TXT ${target.bounceDomain}`);
	else {
		const spf = o.spf.filter((txt) => normalizeTxtContent(txt).toLowerCase().startsWith("v=spf1"));
		if (spf.length > 1) {
			return {
				state: "blocked",
				reason: `${target.bounceDomain} publishes ${spf.length} SPF records; setup:sending refuses to pick one.`,
				remedy: `Delete all but "${SPF_VALUE}" at ${target.bounceDomain}, then re-run.`,
			};
		}
		if (spf.length === 1 && normalizeTxtContent(spf[0] ?? "") === SPF_VALUE) verified.push("SPF");
		else dns.push(`SPF ${target.bounceDomain} -> ${SPF_VALUE}`);
	}

	// Provider DKIM + MX: only knowable once sending is enabled.
	const provider = o.providerRecords ? selectProviderRecords(o.providerRecords, sd) : null;
	if (!provider) {
		if (o.enabled)
			unknown.push(`the provider's DKIM/MX records (wrangler email sending dns get ${sd})`);
		else dns.push("DKIM + MX (published by the provider once enabled)");
	} else {
		if (!provider.dkim) {
			unknown.push(
				`the provider's DKIM record for ${sd} (not in its output yet — still provisioning?)`,
			);
		} else if (o.dkim === null) {
			unknown.push(`TXT ${provider.dkim.name}`);
		} else if (
			o.dkim.some(
				(txt) => normalizeTxtContent(txt) === normalizeTxtContent(provider.dkim?.content ?? ""),
			)
		) {
			verified.push("DKIM");
		} else {
			dns.push(`DKIM ${provider.dkim.name}`);
		}
		if (provider.mx.length === 0) {
			unknown.push(`the provider's MX records for ${target.bounceDomain}`);
		} else if (o.mx === null) {
			unknown.push(`MX ${target.bounceDomain}`);
		} else {
			const absent = provider.mx.filter(
				(want) =>
					!o.mx?.some(
						(have) =>
							have.exchange === canonicalHost(want.content) &&
							have.priority === (want.priority ?? 10),
					),
			);
			if (absent.length === 0) verified.push(`${provider.mx.length} MX`);
			else {
				dns.push(
					`MX ${target.bounceDomain} ${absent.map((r) => `${canonicalHost(r.content)} (${r.priority})`).join(", ")}`,
				);
			}
		}
	}

	// DMARC, compared exactly as setup:sending compares before deciding to patch.
	const wantDmarc = opts.entry.dmarc.value;
	if (o.dmarc === null) unknown.push(`TXT ${target.dmarcDomain}`);
	else {
		const records = o.dmarc.filter((txt) => parseDmarcTags(txt) !== null);
		if (
			records.length === 1 &&
			normalizeTxtContent(records[0] ?? "") === normalizeTxtContent(wantDmarc)
		) {
			verified.push(
				`DMARC p=${opts.entry.dmarc.policy}${opts.dmarc.rua ? ` rua=${opts.dmarc.rua}` : ""}`,
			);
		} else {
			const now =
				records.length === 0
					? "(none)"
					: records.map((r) => `"${normalizeTxtContent(r)}"`).join(" + ");
			// The apex record is the policy for every sender on the zone, not just Reccado.
			dns.push(
				`DMARC ${target.dmarcDomain}: ${now} -> "${wantDmarc}"${target.isApex ? ` (APEX: governs every sender using @${target.zone})` : ""}`,
			);
		}
	}

	// Feedback subscription.
	if ("error" in o.feedback) {
		return {
			state: "blocked",
			reason: `could not verify the event subscription for ${sd}: ${o.feedback.error}`,
			remedy: o.feedback.fix,
		};
	}
	const verdict = o.feedback.verdict;
	if (verdict.state === "wrong_queue") {
		return {
			state: "blocked",
			reason: describeFeedbackVerdict(sd, o.feedback.queue, verdict),
			remedy: `Delete that subscription (pnpm wrangler queues subscription delete <its-queue> --id ${verdict.subscriptionIds[0]}), then re-run — setup:sending never repoints one.`,
		};
	}
	if (verdict.state === "live") verified.push("6 events");
	else missing.push(describeFeedbackVerdict(sd, o.feedback.queue, verdict));

	if (unknown.length > 0) {
		return {
			state: "blocked",
			reason: `could not read ${unknown.join("; ")}.`,
			remedy: `Check pnpm wrangler login and network access, then re-run. To look yourself: pnpm wrangler email sending dns get ${sd}`,
		};
	}
	const allMissing = [...missing, ...dns];
	if (allMissing.length === 0) {
		return {
			state: "already",
			detail: `${sd}: ${verified.join(", ")}.`,
		};
	}
	// Enabling alone makes Cloudflare write a p=reject DMARC nobody chose, so a run that
	// cannot also write DNS would leave the name worse than it found it.
	if (!o.tokenPresent && (dns.length > 0 || o.enabled === false)) {
		return {
			state: "blocked",
			reason: `${sd} needs DNS writes (${dns.join("; ") || "records published after enabling"}), and CLOUDFLARE_API_TOKEN is not set.`,
			remedy: `export CLOUDFLARE_API_TOKEN=<token with Zone · DNS · Edit on ${target.zone}> and re-run (setup:sending upserts SPF/DKIM/MX/DMARC with it).`,
		};
	}
	const args = setupSendingArgs({ env: opts.env, target, dmarc: opts.dmarc, apply: true });
	return {
		state: "todo",
		action: `pnpm ${args.join(" ")}  # fixes: ${allMissing.join("; ")}`,
		plan: { args, missing: allMissing },
	};
}

// ---------------------------------------------------------------------------
// Decisions: generated config and the deployed Worker
// ---------------------------------------------------------------------------

/** Whether writing the generated config would change it, described. */
export function decideSendingConfig(
	update: SendingConfigUpdate,
	generatedPath: string,
): Decision<undefined> {
	const added = update.sendingDomains.filter((d) => !update.previousSendingDomains.includes(d));
	if (!update.changed) {
		return {
			state: "already",
			detail: `${generatedPath} ships MAIL_SENDING_DOMAINS=${update.sendingDomains.join(",")}.`,
		};
	}
	const parts = [
		added.length > 0
			? `MAIL_SENDING_DOMAINS += ${added.join(", ")} (-> ${update.sendingDomains.join(",")})`
			: `MAIL_SENDING_DOMAINS=${update.sendingDomains.join(",")}`,
	];
	if (update.previousFrom === undefined) parts.push(`MAIL_FROM_ADDRESS=${update.nextFrom}`);
	if (update.emailBinding === "bounded") {
		parts.push(`EMAIL.allowed_sender_addresses=${update.allowedSenders?.join(",")}`);
	}
	return { state: "todo", action: `write ${generatedPath}: ${parts.join("; ")}`, plan: undefined };
}

/**
 * Whether the running Worker already carries the sending domains. Onboard never
 * deploys; a missing domain here is `blocked` on a human running the deploy.
 */
export function decideDeployedDomains(opts: {
	env: string | undefined;
	worker: string;
	targets: string[];
	/** MAIL_SENDING_DOMAINS per live version id; null when unreadable. */
	live: Array<{ versionId: string; domains: string[] }> | null;
	liveError?: string;
}): Decision<undefined> {
	const deploy = deployCommandFor(opts.env);
	if (!opts.live || opts.live.length === 0) {
		return {
			state: "blocked",
			reason: `could not read the deployed ${opts.worker} version${opts.liveError ? ` (${opts.liveError})` : ""}.`,
			remedy: `pnpm wrangler deployments status --name ${opts.worker} --json`,
		};
	}
	const gaps = opts.live
		.map((v) => ({ ...v, lacking: opts.targets.filter((d) => !v.domains.includes(d)) }))
		.filter((v) => v.lacking.length > 0);
	if (gaps.length === 0) {
		return {
			state: "already",
			detail: `${opts.worker} (version ${opts.live.map((v) => v.versionId.slice(0, 8)).join(", ")}) ships ${opts.targets.join(", ")}.`,
		};
	}
	return {
		state: "blocked",
		reason: `deploy required: ${opts.worker} ${gaps.map((g) => `version ${g.versionId.slice(0, 8)} lacks ${g.lacking.join(", ")}`).join("; ")} in MAIL_SENDING_DOMAINS, so mail from them does not send as itself yet.`,
		remedy: `${deploy} --dry-run   # review the overlay; then: ${deploy}`,
	};
}

// ---------------------------------------------------------------------------
// Decisions: Email Routing
// ---------------------------------------------------------------------------

export function decideRoutingEnabled(
	zone: string,
	settings: RoutingSettings | null,
): Decision<undefined> {
	if (!settings) {
		return {
			state: "blocked",
			reason: `could not read Email Routing settings for ${zone}.`,
			remedy: `pnpm wrangler email routing settings ${zone}`,
		};
	}
	if (!settings.enabled) {
		return {
			state: "todo",
			action: `pnpm wrangler email routing enable ${zone}`,
			plan: undefined,
		};
	}
	if (settings.status && settings.status !== "ready") {
		return {
			state: "blocked",
			reason: `Email Routing is enabled on ${zone} but its status is "${settings.status}" (DNS not verified).`,
			remedy: `Add the records from: pnpm wrangler email routing dns get ${zone}`,
		};
	}
	return {
		state: "already",
		detail: `Email Routing is enabled on ${zone} (status ${settings.status ?? "unknown"}).`,
	};
}

export type RoutingRuleTodo = { args: string[] };

/**
 * Only creates a literal `to:<address>` → worker rule when no rule mentions the
 * address at all. One that does but is disabled, or delivers elsewhere, is
 * somebody's decision — `blocked`, never overwritten. The catch-all is not
 * considered here at all.
 */
export function decideRoutingRule(opts: {
	zone: string;
	address: string;
	worker: string;
	rules: RoutingRule[] | null;
}): Decision<RoutingRuleTodo> {
	if (!opts.rules) {
		return {
			state: "blocked",
			reason: `could not list Email Routing rules for ${opts.zone}.`,
			remedy: `pnpm wrangler email routing rules list ${opts.zone}`,
		};
	}
	const matching = opts.rules.filter((rule) => ruleMatchesAddress(rule, opts.address));
	const exact = matching.find(
		(rule) => rule.enabled && rule.matchers.length === 1 && ruleDeliversToWorker(rule, opts.worker),
	);
	if (exact) {
		return {
			state: "already",
			detail: `rule ${exact.id.slice(0, 8)}${exact.name ? ` "${exact.name}"` : ""}: to:${opts.address} -> worker:${opts.worker}.`,
		};
	}
	if (matching.length > 0) {
		const describe = matching
			.map(
				(rule) =>
					`${rule.id} (${rule.enabled ? "enabled" : "disabled"}, ${rule.actions.map((a) => `${a.type}${a.values.length ? `:${a.values.join(",")}` : ""}`).join(", ") || "no action"})`,
			)
			.join("; ");
		return {
			state: "blocked",
			reason: `a rule already matches to:${opts.address} but does not deliver it to ${opts.worker}: ${describe}. Not overwriting it.`,
			remedy: `Decide what ${opts.address} should do: edit that rule to worker:${opts.worker}, or delete it (pnpm wrangler email routing rules delete ${opts.zone} <rule-id>), then re-run.`,
		};
	}
	const local = opts.address.slice(0, opts.address.indexOf("@"));
	const args = literalRoutingRuleArgs({
		zone: opts.zone,
		address: opts.address,
		worker: opts.worker,
		name: `${local} -> ${opts.worker}`,
	});
	return { state: "todo", action: `pnpm wrangler ${args.join(" ")}`, plan: { args } };
}

// ---------------------------------------------------------------------------
// Decisions: control plane
// ---------------------------------------------------------------------------

export type DomainRowLike = { id: string; domain: string; zone_id: string; status: string };
export type MailboxRowLike = {
	mailbox_id: string;
	primary_address: string;
	display_name: string | null;
	status: string;
	owner_email: string | null;
};
export type AliasRowLike = { alias_address: string; mailbox_id: string; status: string };

export function decideDomain(opts: {
	zone: string;
	domains: DomainRowLike[];
	zoneId: string | undefined;
	zoneIdSource?: string;
}): Decision<{ zoneId: string }> {
	const row = opts.domains.find((d) => d.domain.toLowerCase() === opts.zone);
	if (row) {
		if (row.status !== "active") {
			return {
				state: "blocked",
				reason: `${opts.zone} is registered but "${row.status}", so nothing on it routes.`,
				remedy: `Re-enable it: PATCH /api/domains/${opts.zone} {"status":"active"} (as the operator), then re-run.`,
			};
		}
		if (opts.zoneId && row.zone_id !== opts.zoneId) {
			return {
				state: "blocked",
				reason: `${opts.zone} is registered with zone_id "${row.zone_id}", but its Cloudflare zone is ${opts.zoneId}${opts.zoneIdSource ? ` (${opts.zoneIdSource})` : ""}.`,
				remedy: `Correct domains.zone_id for ${opts.zone} in D1 (pnpm wrangler d1 execute <INDEX_DB> --remote --command "UPDATE domains SET zone_id='${opts.zoneId}' WHERE domain='${opts.zone}'"), then re-run.`,
			};
		}
		return {
			state: "already",
			detail: `${opts.zone} is registered (zone ${row.zone_id}${opts.zoneId ? `, matches the zone id ${opts.zoneIdSource ?? "known"}` : "; not cross-checked"}).`,
		};
	}
	if (!opts.zoneId) {
		return {
			state: "blocked",
			reason: `${opts.zone} is not registered and its Cloudflare zone id could not be discovered.`,
			remedy: `Add "zoneId" to the manifest (Cloudflare dashboard → ${opts.zone} → Overview → Zone ID), or export CLOUDFLARE_API_TOKEN (Zone · Read) and re-run.`,
		};
	}
	return {
		state: "todo",
		action: `POST /api/domains {"domain":"${opts.zone}","zoneId":"${opts.zoneId}"}`,
		plan: { zoneId: opts.zoneId },
	};
}

export type MailboxTodo =
	| { kind: "create" }
	| { kind: "converge"; mailboxId: string; displayName?: string; repostForPrimaryAlias: boolean };

export function decideMailbox(opts: {
	address: string;
	displayName?: string;
	mailboxes: MailboxRowLike[];
	aliases: AliasRowLike[];
	sessionEmail: string | undefined;
}): Decision<MailboxTodo> {
	const row = opts.mailboxes.find((m) => m.primary_address.toLowerCase() === opts.address);
	const body = JSON.stringify({
		primaryAddress: opts.address,
		...(opts.displayName ? { displayName: opts.displayName } : {}),
	});
	if (!row) {
		return {
			state: "todo",
			action: `POST /api/mailboxes ${body} (also creates the primary alias; owner = ${opts.sessionEmail ?? "the signed-in operator"})`,
			plan: { kind: "create" },
		};
	}
	if (row.status !== "active") {
		return {
			state: "blocked",
			reason: `mailbox ${row.mailbox_id} for ${opts.address} is "${row.status}".`,
			remedy: `Re-enable it: PATCH /api/mailboxes/${row.mailbox_id} {"status":"active"}, then re-run.`,
		};
	}
	if (opts.sessionEmail && row.owner_email?.toLowerCase() !== opts.sessionEmail.toLowerCase()) {
		return {
			state: "blocked",
			reason: `mailbox ${row.mailbox_id} is owned by ${row.owner_email ?? "nobody"}, not ${opts.sessionEmail}; its templates and keys are owner-gated.`,
			remedy: `Sign in as its owner (pnpm operator login --email ${row.owner_email ?? "<owner>"}), or fix mailboxes.owner_email in D1.`,
		};
	}
	const primary = opts.aliases.find((a) => a.alias_address.toLowerCase() === opts.address);
	if (primary && (primary.mailbox_id !== row.mailbox_id || primary.status !== "active")) {
		return {
			state: "blocked",
			reason: `the primary alias ${opts.address} is ${primary.status} and points at ${primary.mailbox_id}, not ${row.mailbox_id}.`,
			remedy: `Fix it: PATCH /api/aliases/${opts.address} {"status":"active"} or DELETE it and re-run (POST /api/mailboxes re-creates it).`,
		};
	}
	const fixes: string[] = [];
	const plan: MailboxTodo = {
		kind: "converge",
		mailboxId: row.mailbox_id,
		repostForPrimaryAlias: !primary,
	};
	if (!primary) fixes.push(`POST /api/mailboxes ${body} (re-creates the missing primary alias)`);
	if (opts.displayName && row.display_name !== opts.displayName) {
		plan.displayName = opts.displayName;
		fixes.push(
			`PATCH /api/mailboxes/${row.mailbox_id} {"displayName":${JSON.stringify(opts.displayName)}} (was ${JSON.stringify(row.display_name)})`,
		);
	}
	if (fixes.length === 0) {
		return {
			state: "already",
			detail: `${opts.address} is mailbox ${row.mailbox_id}${row.display_name ? ` ("${row.display_name}")` : ""}, owner ${row.owner_email}.`,
		};
	}
	return { state: "todo", action: fixes.join("; "), plan };
}

export function decideAlias(opts: {
	alias: string;
	/** The mailbox's id, or undefined when this run would create the mailbox. */
	mailboxId: string | undefined;
	aliases: AliasRowLike[];
}): Decision<undefined> {
	const row = opts.aliases.find((a) => a.alias_address.toLowerCase() === opts.alias);
	const target = opts.mailboxId ?? "<new mailbox id>";
	if (!row) {
		return {
			state: "todo",
			action: `POST /api/aliases {"aliasAddress":"${opts.alias}","mailboxId":"${target}"}`,
			plan: undefined,
		};
	}
	if (row.mailbox_id !== opts.mailboxId) {
		return {
			state: "blocked",
			reason: `${opts.alias} already routes to mailbox ${row.mailbox_id}, not ${target}.`,
			remedy: `If it should move: DELETE /api/aliases/${opts.alias}, then re-run. Otherwise drop it from the manifest.`,
		};
	}
	if (row.status !== "active") {
		return {
			state: "blocked",
			reason: `${opts.alias} points at ${row.mailbox_id} but is "${row.status}".`,
			remedy: `PATCH /api/aliases/${opts.alias} {"status":"active"}, then re-run.`,
		};
	}
	return { state: "already", detail: `${opts.alias} -> mailbox ${row.mailbox_id}.` };
}

// ---------------------------------------------------------------------------
// Decisions: templates
// ---------------------------------------------------------------------------

export type ExistingTemplate = {
	id: string;
	subject: string;
	body_text: string | null;
	body_html: string | null;
};

export type TemplateDiff = {
	create: string[];
	update: string[];
	unchanged: string[];
	archive: string[];
};

/**
 * What `PUT .../transactional/templates` would do, from the ACTIVE templates the
 * GET returns. Archived ids are invisible to that GET; the sync reports them as
 * `archived: already_archived` rather than reviving them, which
 * `interpretTemplateSync` turns into `blocked`.
 */
export function diffTemplates(
	desired: TemplateInput[],
	existing: ExistingTemplate[],
	archiveMissing: boolean,
): TemplateDiff {
	const byId = new Map(existing.map((t) => [t.id, t]));
	const diff: TemplateDiff = { create: [], update: [], unchanged: [], archive: [] };
	for (const t of desired) {
		const row = byId.get(t.id);
		if (!row) diff.create.push(t.id);
		else if (
			row.subject === t.subject &&
			(row.body_text ?? null) === (t.body_text ?? null) &&
			(row.body_html ?? null) === (t.body_html ?? null)
		) {
			diff.unchanged.push(t.id);
		} else diff.update.push(t.id);
	}
	if (archiveMissing) {
		const wanted = new Set(desired.map((t) => t.id));
		for (const row of existing) if (!wanted.has(row.id)) diff.archive.push(row.id);
	}
	return diff;
}

export function decideTemplates(opts: {
	mailboxId: string | undefined;
	file: string;
	diff: TemplateDiff;
	archiveMissing: boolean;
}): Decision<undefined> {
	const { diff } = opts;
	if (diff.create.length + diff.update.length + diff.archive.length === 0) {
		return {
			state: "already",
			detail: `${diff.unchanged.length} template(s) match ${opts.file}${opts.archiveMissing ? "; none to archive" : ""}.`,
		};
	}
	const parts = [
		diff.create.length ? `create ${diff.create.join(", ")}` : "",
		diff.update.length ? `update ${diff.update.join(", ")}` : "",
		diff.archive.length ? `archive ${diff.archive.join(", ")}` : "",
		diff.unchanged.length ? `${diff.unchanged.length} unchanged` : "",
	].filter(Boolean);
	return {
		state: "todo",
		action: `PUT /api/mailboxes/${opts.mailboxId ?? "<new mailbox id>"}/transactional/templates {templates from ${opts.file}${opts.archiveMissing ? ", archiveMissing: true" : ""}} (${parts.join("; ")})`,
		plan: undefined,
	};
}

export type TemplateSyncResult = { id: string; outcome: string; reason?: string };

/** Outcome of a PUT sync. An id that is archived server-side is `blocked`: the sync never revives it. */
export function interpretTemplateSync(results: TemplateSyncResult[]): OnboardOutcome {
	const archivedSkipped = results.filter(
		(r) => r.outcome === "archived" && r.reason === "already_archived",
	);
	const counts = { created: 0, updated: 0, unchanged: 0, archived: 0 };
	for (const r of results) {
		if (r.outcome in counts && r.reason !== "already_archived")
			counts[r.outcome as keyof typeof counts] += 1;
	}
	const summary = `created ${counts.created}, updated ${counts.updated}, unchanged ${counts.unchanged}, archived ${counts.archived}`;
	if (archivedSkipped.length > 0) {
		return {
			state: "blocked",
			reason: `synced (${summary}), but ${archivedSkipped.map((r) => r.id).join(", ")} ${archivedSkipped.length === 1 ? "is" : "are"} archived on the server and the sync never revives an archived id.`,
			remedy:
				"Give those templates new ids in the templates file (and any key allowlist), then re-run.",
		};
	}
	return { state: "done", detail: `templates synced: ${summary}.` };
}

// ---------------------------------------------------------------------------
// Decisions: API keys + 1Password
// ---------------------------------------------------------------------------

export type KeyStoreObservation =
	/** The manifest names no store. */
	| { kind: "none" }
	/** `op` could not be used (not installed, locked, no such vault). */
	| { kind: "unavailable"; reason: string }
	| { kind: "absent" }
	| { kind: "ambiguous"; itemIds: string[] }
	| { kind: "present"; itemId: string; keyId?: string; endpoint?: string };

export type ApiKeyEntry = {
	keyId: string;
	status: string;
	environment: string;
	sender: string;
	senderName: string | null;
	scopes: string[];
	templateAllowlist: string[] | null;
	recipientPolicy: string | null;
	quotaMax: number | null;
};

export type KeyTodo =
	| { kind: "mint" }
	| { kind: "fix"; itemId: string; keyId: string; senderName?: string | null; endpoint?: string };

function sameSet(
	a: readonly string[] | null | undefined,
	b: readonly string[] | null | undefined,
): boolean {
	const x = [...new Set(a ?? [])].sort();
	const y = [...new Set(b ?? [])].sort();
	return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Differences between a live key and the body the manifest would mint. Only
 * `senderName` can be changed in place (PATCH); everything else is fixed at
 * creation, and even rotation copies it verbatim.
 */
export function diffKey(
	body: KeyCreateBody,
	entry: ApiKeyEntry,
): { senderName: boolean; fixed: string[] } {
	const fixed: string[] = [];
	if (entry.environment !== body.environment)
		fixed.push(`environment ${entry.environment} ≠ ${body.environment}`);
	if (entry.sender.toLowerCase() !== body.sender.toLowerCase())
		fixed.push(`sender ${entry.sender} ≠ ${body.sender}`);
	if (!sameSet(entry.scopes, body.scopes))
		fixed.push(`scopes [${entry.scopes.join(",")}] ≠ [${body.scopes.join(",")}]`);
	if (!sameSet(entry.templateAllowlist, body.templateAllowlist ?? null)) {
		const have = new Set(entry.templateAllowlist ?? []);
		const want = new Set(body.templateAllowlist ?? []);
		const add = [...want].filter((id) => !have.has(id));
		const drop = [...have].filter((id) => !want.has(id));
		fixed.push(
			`templateAllowlist${add.length ? ` lacks ${add.join(",")}` : ""}${drop.length ? `${add.length ? " and" : ""} has extra ${drop.join(",")}` : ""}`,
		);
	}
	if ((entry.recipientPolicy ?? null) !== (body.recipientPolicy ?? null)) {
		fixed.push(
			`recipientPolicy ${JSON.stringify(entry.recipientPolicy)} ≠ ${JSON.stringify(body.recipientPolicy ?? null)}`,
		);
	}
	if ((entry.quotaMax ?? null) !== (body.quotaMax ?? null)) {
		fixed.push(`quotaMax ${entry.quotaMax ?? "none"} ≠ ${body.quotaMax ?? "none"}`);
	}
	const senderName = (entry.senderName ?? null) !== (body.senderName?.trim() || null);
	return { senderName, fixed };
}

/**
 * Keys have no name server-side, so the store IS the idempotency key: an item
 * that holds a `key id` which is active on this mailbox means the key exists.
 * Every other combination either mints exactly one key (nothing stored yet) or
 * stops — a second key is never minted silently next to a stored one.
 */
export function decideKey(opts: {
	name: string;
	body: KeyCreateBody;
	store: KeyStoreObservation;
	storeLabel?: string;
	/** null when the mailbox does not exist yet (dry run before it is created). */
	keys: ApiKeyEntry[] | null;
	mailboxId: string | undefined;
	endpoint: string | undefined;
}): Decision<KeyTodo> {
	const where = opts.storeLabel ?? "the store";
	switch (opts.store.kind) {
		case "none":
			return {
				state: "blocked",
				reason: `key "${opts.name}" has no "store": its plaintext is shown exactly once, and a key that cannot be stored is a lost key.`,
				remedy: `Add "store": {"onePassword": {"vault": "...", "title": "..."}} to the key in the manifest.`,
			};
		case "unavailable":
			return {
				state: "blocked",
				reason: `cannot use 1Password for ${where}: ${opts.store.reason}`,
				remedy: "Unlock 1Password / sign in (op signin) and check the vault name, then re-run.",
			};
		case "ambiguous":
			return {
				state: "blocked",
				reason: `${where} matches ${opts.store.itemIds.length} items (${opts.store.itemIds.join(", ")}); which one holds the key is ambiguous.`,
				remedy: "Rename or delete the extra items so exactly one has this title, then re-run.",
			};
		case "absent":
			return {
				state: "todo",
				action: `POST /api/mailboxes/${opts.mailboxId ?? "<new mailbox id>"}/transactional/api-keys ${JSON.stringify(opts.body)} -> store plaintext in 1Password ${where}`,
				plan: { kind: "mint" },
			};
		case "present":
			break;
	}
	const { itemId, keyId, endpoint } = opts.store;
	if (!keyId) {
		return {
			state: "blocked",
			reason: `${where} (item ${itemId}) exists but has no "key id" field, so which key it holds is unknown.`,
			remedy: `Add the key id to the item, or delete it (op item delete ${itemId}) and re-run to mint a new key.`,
		};
	}
	const entry = opts.keys?.find((k) => k.keyId === keyId);
	if (entry?.status !== "active") {
		return {
			state: "blocked",
			reason: `${where} holds key ${keyId}, which is ${entry ? entry.status : opts.keys ? "not a key of this mailbox" : "on a mailbox that does not exist yet"}.`,
			remedy: entry
				? `The stored secret is dead. Delete the item (op item delete ${itemId}) and re-run --apply to mint and store a fresh key.`
				: `Check the item belongs to this deployment/mailbox. If it is stale, delete it (op item delete ${itemId}) and re-run --apply; if the key is live elsewhere, rotate it there instead.`,
		};
	}
	const diff = diffKey(opts.body, entry);
	if (diff.fixed.length > 0) {
		return {
			state: "blocked",
			reason: `key ${keyId} differs from the manifest in fields fixed at creation: ${diff.fixed.join("; ")}.`,
			remedy: `Either change the manifest to match, or mint a replacement: revoke ${keyId} (POST /api/mailboxes/${opts.mailboxId}/transactional/api-keys/${keyId}/revoke), delete the item (op item delete ${itemId}), and re-run --apply. Rotation copies these fields, so it cannot fix them.`,
		};
	}
	const plan: KeyTodo = { kind: "fix", itemId, keyId };
	const fixes: string[] = [];
	if (diff.senderName) {
		plan.senderName = opts.body.senderName?.trim() || null;
		fixes.push(
			`PATCH /api/mailboxes/${opts.mailboxId}/transactional/api-keys/${keyId} {"senderName":${JSON.stringify(plan.senderName)}}`,
		);
	}
	if (opts.endpoint && endpoint !== opts.endpoint) {
		plan.endpoint = opts.endpoint;
		fixes.push(
			`op item edit ${itemId} RECCADO_ENDPOINT=${opts.endpoint} (was ${endpoint ?? "unset"})`,
		);
	}
	if (fixes.length === 0) {
		return { state: "already", detail: `key ${keyId} is active; stored in 1Password ${where}.` };
	}
	return { state: "todo", action: fixes.join("; "), plan };
}

/** The item JSON for `op item create --template`. Only this function ever holds plaintext in a structure. */
export function buildOnePasswordItem(opts: {
	title: string;
	plaintextKey: string;
	endpoint: string;
	keyId: string;
	notes: string;
}): Record<string, unknown> {
	return {
		title: opts.title,
		category: "API_CREDENTIAL",
		fields: [
			{ id: "credential", type: "CONCEALED", label: "credential", value: opts.plaintextKey },
			{ id: "endpoint", type: "STRING", label: "RECCADO_ENDPOINT", value: opts.endpoint },
			{ id: "keyid", type: "STRING", label: "key id", value: opts.keyId },
			{
				id: "notesPlain",
				type: "STRING",
				purpose: "NOTES",
				label: "notesPlain",
				value: opts.notes,
			},
		],
	};
}

/** Items from `op item list --format json` with exactly this title. */
export function findItemsByTitle(listJson: string, title: string): string[] {
	const items = JSON.parse(listJson) as unknown;
	if (!Array.isArray(items)) throw new Error("op item list did not return a JSON array");
	return items
		.filter((item) => (item as { title?: unknown }).title === title)
		.map((item) => String((item as { id?: unknown }).id ?? ""));
}

/**
 * `op item get --fields label=a,label=b --format json` returns one object for a
 * single field and an array for several. Label → value; nothing else is kept.
 */
export function parseOpFields(json: string): Record<string, string> {
	const parsed = JSON.parse(json) as unknown;
	const fields = Array.isArray(parsed) ? parsed : [parsed];
	const out: Record<string, string> = {};
	for (const field of fields) {
		const f = field as { label?: unknown; value?: unknown };
		if (typeof f.label === "string" && typeof f.value === "string") out[f.label] = f.value;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Parsers for the deployed Worker
// ---------------------------------------------------------------------------

/** Version ids serving traffic, from `wrangler deployments status --json`. */
export function parseDeploymentStatus(raw: string): string[] | null {
	const start = raw.indexOf("{");
	if (start === -1) return null;
	try {
		const parsed = JSON.parse(raw.slice(start)) as {
			versions?: Array<{ version_id?: string; percentage?: number }>;
		};
		const ids = (parsed.versions ?? [])
			.filter((v) => typeof v.version_id === "string" && (v.percentage ?? 0) > 0)
			.map((v) => v.version_id as string);
		return ids.length > 0 ? ids : null;
	} catch {
		return null;
	}
}

/** Plain-text vars of a version, from `wrangler versions view <id> --json`. */
export function parseVersionVars(raw: string): Record<string, string> | null {
	const start = raw.indexOf("{");
	if (start === -1) return null;
	try {
		const parsed = JSON.parse(raw.slice(start)) as {
			resources?: { bindings?: Array<{ type?: string; name?: string; text?: string }> };
		};
		const bindings = parsed.resources?.bindings;
		if (!Array.isArray(bindings)) return null;
		const vars: Record<string, string> = {};
		for (const b of bindings) {
			if (b.type === "plain_text" && typeof b.name === "string" && typeof b.text === "string") {
				vars[b.name] = b.text;
			}
		}
		return vars;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Decisions: Telegram topic
// ---------------------------------------------------------------------------

/**
 * What GET /api/telegram/status says about the bridge, reduced to what the
 * `telegram:topic` step decides from. `isForum` is Telegram's live answer when
 * getChat succeeded, else the stored flag.
 */
export type TelegramTopicObservation = {
	bridgeOn: boolean;
	chatId: string | null;
	isForum: boolean | null;
	/** Null when the bot's membership could not be read. */
	canManageTopics: boolean | null;
	/** The mailbox's mapping in the bound chat; null when none (or the mailbox does not exist yet). */
	mapping: { topicId: number; topicName: string | null; effectiveName: string } | null;
};

export type TelegramTopicPlan = { name?: string; adoptThreadId?: number };

function telegramTopicCommand(address: string, spec: TelegramTopicPlan, replace: boolean): string {
	const how =
		spec.adoptThreadId !== undefined
			? `--adopt ${spec.adoptThreadId}${spec.name ? ` --name ${JSON.stringify(spec.name)}` : ""}`
			: `--name ${JSON.stringify(spec.name ?? "")}`;
	return `pnpm operator telegram topic ${address} ${how}${replace ? " --replace" : ""} --apply`;
}

/**
 * The mailbox's topic in the bound forum: `already` when the mapping the
 * manifest asks for is in place, `todo` (POST /api/telegram/topics) when there
 * is none, `blocked` otherwise.
 *
 * Never replaces a mapping, the way routing rules are never overwritten: a
 * mapping decides where the mailbox's mail lands, and the remedy prints the
 * exact `--replace` command for the operator to choose. With neither a name nor
 * a thread id, any existing mapping is accepted and a missing one is created
 * under the mailbox's display name (else its address) -- stored with the
 * mapping, so later display-name changes do not rename the topic.
 */
export function decideTelegramTopic(opts: {
	spec: TelegramTopicSpec;
	address: string;
	displayName?: string;
	observed: TelegramTopicObservation;
}): Decision<TelegramTopicPlan> {
	const { spec, address, observed } = opts;
	if (!observed.bridgeOn) {
		return {
			state: "blocked",
			reason: "the Telegram bridge is off (TELEGRAM_BOT_TOKEN is not set on the worker).",
			remedy:
				"Set it: pnpm wrangler secret put TELEGRAM_BOT_TOKEN --env <env>, bind a forum, then re-run.",
		};
	}
	if (!observed.chatId) {
		return {
			state: "blocked",
			reason: "no Telegram chat is bound.",
			remedy:
				"Send /start to the bot from the forum, or: pnpm operator telegram rebind --chat <forum chat id> --apply; then re-run.",
		};
	}
	if (observed.isForum !== true) {
		return {
			state: "blocked",
			reason: `the bound chat ${observed.chatId} is not a forum${observed.isForum === null ? " (never observed)" : ""}.`,
			remedy: `Turn on Topics in the group (or move the bridge to a forum), then: pnpm operator telegram rebind --chat <forum chat id> --apply; then re-run.`,
		};
	}
	const plan: TelegramTopicPlan =
		spec.adoptThreadId !== undefined
			? {
					adoptThreadId: spec.adoptThreadId,
					...(spec.topicName ? { name: spec.topicName } : {}),
				}
			: { name: spec.topicName ?? opts.displayName ?? address };

	const existing = observed.mapping;
	if (existing) {
		const same =
			spec.adoptThreadId !== undefined
				? existing.topicId === spec.adoptThreadId &&
					(spec.topicName === undefined || spec.topicName === existing.topicName)
				: spec.topicName === undefined || spec.topicName === existing.topicName;
		if (same) {
			return {
				state: "already",
				detail: `${address} -> topic ${existing.topicId} "${existing.effectiveName}" in ${observed.chatId}.`,
			};
		}
		return {
			state: "blocked",
			reason: `${address} is already mapped to topic ${existing.topicId} "${existing.effectiveName}"${existing.topicName ? "" : " (unnamed: follows the mailbox)"} in ${observed.chatId}, not to what the manifest asks.`,
			remedy: `If it should move: ${telegramTopicCommand(address, plan, true)}. Otherwise align the manifest's telegram block.`,
		};
	}
	if (plan.adoptThreadId === undefined && observed.canManageTopics === false) {
		return {
			state: "blocked",
			reason: `the bot cannot create topics in ${observed.chatId} (no can_manage_topics).`,
			remedy:
				"Make the bot an administrator with Manage Topics, or create the topic yourself and set telegram.adoptThreadId; then re-run.",
		};
	}
	return {
		state: "todo",
		action: `POST /api/telegram/topics ${JSON.stringify(plan)} for ${address} in ${observed.chatId}${plan.adoptThreadId === undefined ? " (creates the forum topic)" : " (maps the existing thread; unverifiable until pnpm smoke:telegram)"}`,
		plan,
	};
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const LABEL: Record<OnboardOutcome["state"], string> = {
	already: "already",
	done: "done",
	would_do: "would do",
	skipped: "skipped",
	blocked: "blocked",
	failed: "failed",
};

export function outcomeText(outcome: OnboardOutcome): string {
	switch (outcome.state) {
		case "already":
		case "done":
			return outcome.detail;
		case "would_do":
			return outcome.action;
		case "skipped":
			return outcome.reason;
		case "blocked":
			return outcome.reason;
		case "failed":
			return outcome.error;
	}
}

/** One line per step (plus a remedy line for `blocked`), column-aligned. */
export function formatResults(results: StepResult[], width?: number): string[] {
	const idWidth = width ?? Math.min(48, Math.max(4, ...results.map((r) => r.id.length)));
	const lines: string[] = [];
	for (const r of results) {
		lines.push(
			`  ${LABEL[r.outcome.state].padEnd(8)}  ${r.id.padEnd(idWidth)}  ${outcomeText(r.outcome)}`,
		);
		if (r.outcome.state === "blocked") {
			lines.push(`  ${"".padEnd(8)}  ${"".padEnd(idWidth)}  -> ${r.outcome.remedy}`);
		}
	}
	return lines;
}

export function tally(results: StepResult[]): Record<OnboardOutcome["state"], number> {
	const counts: Record<OnboardOutcome["state"], number> = {
		already: 0,
		done: 0,
		would_do: 0,
		skipped: 0,
		blocked: 0,
		failed: 0,
	};
	for (const r of results) counts[r.outcome.state] += 1;
	return counts;
}

/** Exit code: non-zero when anything failed, is blocked, or was skipped because of either. */
export function exitCodeFor(results: StepResult[]): number {
	return results.some((r) => isFailure(r.outcome)) ? 1 : 0;
}
