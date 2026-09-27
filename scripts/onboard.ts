#!/usr/bin/env tsx
/**
 * `pnpm onboard` — onboard one product (a zone, its sending names, a support
 * mailbox, its aliases, templates and API keys) from a single JSON manifest.
 *
 * It replaces a dozen hand-run steps across setup:sending, raw wrangler, the
 * control-plane API and 1Password. Each step reads the current state first and
 * reports what it found, so the command doubles as a drift check.
 *
 * SAFETY: dry-run by default. A dry run only READS — `wrangler` list/get
 * commands, public DNS over DoH, GETs on the control plane, `op item list/get`
 * for the `key id` / RECCADO_ENDPOINT fields only — and prints, per step,
 * `already`, `would do: <exact action>`, or `blocked: <reason>` with a remedy.
 * Nothing is written anywhere: no Cloudflare mutation, no API write, no
 * generated-config write, no 1Password write.
 *
 * `--apply` performs the missing steps in dependency order and reports
 * `already | done | skipped | blocked | failed` per step (the vocabulary of
 * src/lib/provision.ts). A step that cannot run skips only its dependents. A
 * second `--apply` is all `already`.
 *
 * Steps (dependencies in brackets):
 *   sending:<name>      Email Sending + SPF/DKIM/MX/DMARC + 6-event subscription, per name
 *                       (`send.<zone>`, and the apex with `sending.apex`). Applied by running
 *                       `pnpm setup:sending ... --apply`, the one owner of those upserts.
 *   config:...          MAIL_SENDING_DOMAINS in wrangler.generated.<env>.json      [sending:*]
 *   deployed:...        the running Worker carries them (never deploys; blocked
 *                       with the deploy command when it does not)                  [config]
 *   routing:enable      Email Routing on the zone
 *   routing:<address>   one literal to:<address> -> worker rule per address; an
 *                       existing rule with the same matcher and another action is
 *                       blocked, never overwritten; the catch-all is never touched [routing:enable]
 *   domain              POST /api/domains
 *   mailbox             POST /api/mailboxes (+ primary alias)                      [domain]
 *   alias:<address>     POST /api/aliases                                          [mailbox]
 *   templates           PUT  /api/mailboxes/:id/transactional/templates           [mailbox]
 *   telegram:topic      POST /api/telegram/topics: the mailbox's forum topic in the bound
 *                       chat (manifest `telegram`); `already` when mapped as asked, blocked
 *                       (never replaced) when mapped otherwise or no forum is bound [mailbox]
 *   key:<name>          POST /api/mailboxes/:id/transactional/api-keys, plaintext
 *                       straight into 1Password; idempotent via the stored key id [mailbox, templates, sending]
 *
 * Usage:
 *   pnpm onboard --env dev --manifest ./onboard.json [--host inbox.example.com] [--apply]
 *
 * Needs: `pnpm wrangler login`; a control-plane session (`pnpm operator login --env <env>
 * --host <host> --email <owner>`); `op` signed in for keys with a 1Password store; and, for any
 * DNS write, CLOUDFLARE_API_TOKEN (Zone · DNS · Edit), which setup:sending uses.
 *
 * Never prints an API key's plaintext, the session cookie, or a 1Password credential.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TelegramOperatorStatus } from "../src/telegram/admin/status";
import type { TopicMappingResult } from "../src/telegram/admin/topics";
import { generatedConfigPathFor, readGeneratedConfig, readTrackedConfig } from "./lib/built-config";
import { deployedVars, effectiveBlock, parseDomainList } from "./lib/deploy-config";
import { lookupTxt } from "./lib/dmarc";
import { lookupMx } from "./lib/dns-lookup";
import {
	type EventSubscription,
	evaluateFeedbackSubscription,
	MIN_WRANGLER_FOR_EMAIL_SENDING,
	parseQueueListTable,
	parseSendingDomainsTable,
	parseSubscriptionListJson,
} from "./lib/event-subscriptions";
import {
	type AliasRowLike,
	type ApiKeyEntry,
	buildOnePasswordItem,
	type DomainRowLike,
	decideAlias,
	decideDeployedDomains,
	decideDomain,
	decideKey,
	decideMailbox,
	decideRoutingEnabled,
	decideRoutingRule,
	decideSendingConfig,
	decideSendingTarget,
	decideTelegramTopic,
	decideTemplates,
	deployCommandFor,
	diffTemplates,
	type ExistingTemplate,
	endpointFor,
	exitCodeFor,
	findItemsByTitle,
	formatResults,
	interpretTemplateSync,
	type KeyCreateBody,
	type KeyStoreObservation,
	type MailboxRowLike,
	type ManifestKey,
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
	type SendingPlanEntry,
	type StepSpec,
	settle,
	type TelegramTopicObservation,
	type TemplateInput,
	type TemplateSyncResult,
	tally,
	validateManifest,
} from "./lib/onboard-core";
import {
	loadSession,
	loginCommandHint,
	OperatorAuthError,
	OperatorHttpError,
	OperatorInputError,
	type OperatorSession,
	operatorJson,
	originFor,
	redact,
	resolveHost,
} from "./lib/operator-session";
import { parseRoutingRulesList, parseRoutingSettings, type RoutingRule } from "./lib/routing";
import { planSendingConfigUpdate } from "./lib/sending-config";
import { parseWranglerDnsGetOutput, selectProviderRecords } from "./lib/sending-plan";
import { firstLine, wranglerCapture } from "./lib/wrangler-cli";

const USAGE = `Usage: pnpm onboard --env <env> --manifest <file.json> [--host <host>] [--apply]

  Dry run by default: reads every step's current state and prints already / would do / blocked.
  --apply performs the missing steps (never deploys, never overwrites a routing rule).
  See examples/onboard/ for a manifest, and docs/OPERATIONS.md ("Onboarding a product").`;

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg?.startsWith("--")) continue;
		const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
		if (!rawKey) continue;
		if (inlineValue !== undefined) {
			args[rawKey] = inlineValue;
			continue;
		}
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			args[rawKey] = "true";
			continue;
		}
		args[rawKey] = next;
		i += 1;
	}
	return args;
}

function die(message: string, code = 2): never {
	console.error(`onboard: ${message}`);
	process.exit(code);
}

function readJson(path: string, what: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		die(`cannot read ${what} ${path}: ${(error as Error).message}`);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		die(`${what} ${path} is not valid JSON: ${(error as Error).message}`);
	}
}

/** Memoized async read, with a reset for after a write. */
function memo<T>(fn: () => Promise<T>): (() => Promise<T>) & { reset: () => void } {
	let pending: Promise<T> | undefined;
	const get = () => {
		pending ??= fn();
		return pending;
	};
	return Object.assign(get, {
		reset: () => {
			pending = undefined;
		},
	});
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.help === "true" || args.h === "true") {
	console.log(USAGE);
	process.exit(0);
}
const mode: Mode = args.apply === "true" ? "apply" : "dry-run";
const env = args.env;
const manifestPath = args.manifest
	? resolve(args.manifest)
	: die(`--manifest is required.\n\n${USAGE}`);

const validated = validateManifest(readJson(manifestPath, "manifest"));
if (!validated.ok) {
	die(`invalid manifest ${manifestPath}:\n  - ${validated.errors.join("\n  - ")}`);
}
const manifest: ResolvedManifest = validated.value;

let templates: TemplateInput[] | null = null;
let templatesPath: string | undefined;
if (manifest.templates) {
	templatesPath = resolve(dirname(manifestPath), manifest.templates.file);
	const parsed = parseTemplatesFile(readJson(templatesPath, "templates file"));
	if (!parsed.ok)
		die(`invalid templates file ${templatesPath}:\n  - ${parsed.errors.join("\n  - ")}`);
	templates = parsed.value;
}
const bodies = resolveKeyBodies(manifest.keys, templates ? templates.map((t) => t.id) : null);
if (!bodies.ok) die(`invalid keys in ${manifestPath}:\n  - ${bodies.errors.join("\n  - ")}`);
const keyBodies: Map<string, KeyCreateBody> = bodies.value;

const tracked = readTrackedConfig();
let trackedBlock: ReturnType<typeof effectiveBlock>;
try {
	trackedBlock = effectiveBlock(tracked, env);
} catch (error) {
	die(`wrangler.jsonc: ${(error as Error).message}`);
}
const worker =
	trackedBlock.name ?? die(`could not resolve the Worker name for env "${env ?? "production"}".`);
const eventsQueue = trackedBlock.queues?.producers?.find(
	(producer) => producer.binding === "EMAIL_EVENTS_QUEUE",
)?.queue;
const generatedPath = generatedConfigPathFor(env);

let host: string;
try {
	host = resolveHost(args.host, env);
} catch (error) {
	die((error as Error).message);
}
const origin = originFor(host);

let session: OperatorSession | undefined;
let sessionProblem: string | undefined;
try {
	session = loadSession(host);
	if (!session) sessionProblem = `Not signed in to ${host}.`;
} catch (error) {
	sessionProblem = (error as Error).message;
}

const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || undefined;
const zone = manifest.zone;
const sendingDomains = manifest.sending.map((entry) => entry.target.sendingDomain);

/** Every plaintext this run handles; redacted from anything printed. */
const secrets: string[] = [];
const scrub = (text: string) => redact(text, [...secrets, session?.cookie]);

const generatedBefore = existsSync(generatedPath) ? readFileSync(generatedPath, "utf8") : null;

// ---------------------------------------------------------------------------
// Readers (memoized; reset after the writes that change them)
// ---------------------------------------------------------------------------

class NoSessionError extends Error {}

async function api<T>(
	path: string,
	init: Omit<RequestInit, "body"> & { body?: unknown } = {},
): Promise<T> {
	if (!session) throw new NoSessionError(sessionProblem ?? `Not signed in to ${host}.`);
	return operatorJson<T>(session, path, init, { env });
}

const readSendingList = memo(async () => {
	const listed = wranglerCapture(["email", "sending", "list"]);
	return listed.ok ? parseSendingDomainsTable(listed.out) : null;
});

type FeedbackState =
	| { ok: true; queueId: string; subscriptions: EventSubscription[] }
	| { ok: false; error: string; fix: string };

const readFeedback = memo(async (): Promise<FeedbackState> => {
	if (!eventsQueue) {
		return {
			ok: false,
			error: `no EMAIL_EVENTS_QUEUE producer is declared for env "${env ?? "production"}"`,
			fix: "Add the EMAIL_EVENTS_QUEUE producer to wrangler.jsonc, then re-run.",
		};
	}
	const listed = wranglerCapture(["queues", "subscription", "list", eventsQueue, "--json"]);
	const subscriptions = listed.ok ? parseSubscriptionListJson(listed.out) : null;
	if (!subscriptions) {
		return {
			ok: false,
			error: `could not read the subscriptions on ${eventsQueue}${listed.err.trim() ? ` (${firstLine(listed.err)})` : ""}`,
			fix: `pnpm wrangler queues subscription list ${eventsQueue} --json — check pnpm wrangler login and wrangler >= ${MIN_WRANGLER_FOR_EMAIL_SENDING}.`,
		};
	}
	const queues = wranglerCapture(["queues", "list"]);
	const queueId = queues.ok
		? parseQueueListTable(queues.out).find((queue) => queue.name === eventsQueue)?.id
		: undefined;
	if (!queueId) {
		return {
			ok: false,
			error: `queue ${eventsQueue} was not found in this account`,
			fix: `pnpm wrangler queues create ${eventsQueue} (or pnpm setup:cloud${env ? ` --env ${env}` : ""})`,
		};
	}
	return { ok: true, queueId, subscriptions };
});

const readRoutingSettings = memo(async () => {
	const out = wranglerCapture(["email", "routing", "settings", zone]);
	return out.ok ? parseRoutingSettings(out.out) : null;
});

const readRoutingRules = memo(async (): Promise<RoutingRule[] | null> => {
	const out = wranglerCapture(["email", "routing", "rules", "list", zone]);
	return out.ok ? parseRoutingRulesList(out.out).rules : null;
});

const readDomains = memo(
	async () => (await api<{ domains: DomainRowLike[] }>("/api/domains")).domains,
);
const readMailboxes = memo(
	async () => (await api<{ mailboxes: MailboxRowLike[] }>("/api/mailboxes")).mailboxes,
);
const readAliases = memo(
	async () => (await api<{ aliases: AliasRowLike[] }>("/api/aliases")).aliases,
);

async function currentMailboxId(): Promise<string | undefined> {
	return (await readMailboxes()).find(
		(m) => m.primary_address.toLowerCase() === manifest.mailbox.address,
	)?.mailbox_id;
}

/**
 * The zone id: the manifest's, else the one an existing email.sending
 * subscription in this zone already carries (no token needed), else a REST
 * lookup with CLOUDFLARE_API_TOKEN.
 */
async function discoverZoneId(
	allowTokenLookup: boolean,
): Promise<{ id?: string; source?: string }> {
	if (manifest.zoneId) return { id: manifest.zoneId, source: "from the manifest" };
	const feedback = await readFeedback();
	if (feedback.ok) {
		const fromSub = feedback.subscriptions.find(
			(sub) =>
				sub.source.type === "email.sending" &&
				sub.source.zone_id &&
				(sub.source.domain?.toLowerCase() === zone ||
					sub.source.domain?.toLowerCase().endsWith(`.${zone}`)),
		)?.source.zone_id;
		if (fromSub) return { id: fromSub, source: "from an email.sending event subscription" };
	}
	if (allowTokenLookup && token) {
		try {
			const response = await fetch(
				`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zone)}&status=active&per_page=1`,
				{ headers: { Authorization: `Bearer ${token}` } },
			);
			const json = (await response.json()) as {
				success?: boolean;
				result?: Array<{ id?: string }>;
			};
			const id = json.success ? json.result?.[0]?.id : undefined;
			if (id) return { id, source: "from the Cloudflare API" };
		} catch {
			// Reported as "could not be discovered" by the decision.
		}
	}
	return {};
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function guarded(fn: () => Promise<OnboardOutcome>): Promise<OnboardOutcome> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof NoSessionError || error instanceof OperatorAuthError) {
			return {
				state: "blocked",
				reason: error.message.split(" Run:")[0] ?? error.message,
				remedy: `${loginCommandHint(host, env)} --email <owner>`,
			};
		}
		throw error;
	}
}

async function observeSending(entry: SendingPlanEntry): Promise<SendingObservation> {
	const { target } = entry;
	const sd = target.sendingDomain;
	const list = await readSendingList();
	const enabled = list ? list.some((domain) => domain.name === sd && domain.enabled) : null;
	let providerRecords: SendingObservation["providerRecords"] = null;
	if (enabled) {
		const dns = wranglerCapture(["email", "sending", "dns", "get", sd]);
		providerRecords = dns.ok ? parseWranglerDnsGetOutput(dns.out) : null;
	}
	const provider = providerRecords ? selectProviderRecords(providerRecords, sd) : null;
	const [spf, dkim, mx, dmarc] = await Promise.all([
		lookupTxt(target.bounceDomain),
		provider?.dkim ? lookupTxt(provider.dkim.name) : Promise.resolve(null),
		lookupMx(target.bounceDomain),
		lookupTxt(target.dmarcDomain),
	]);
	const feedback = await readFeedback();
	return {
		enabled,
		providerRecords,
		spf,
		dkim,
		mx,
		dmarc,
		feedback: feedback.ok
			? {
					verdict: evaluateFeedbackSubscription({
						sendingDomain: sd,
						expectedQueueId: feedback.queueId,
						subscriptions: feedback.subscriptions,
					}),
					queue: eventsQueue ?? "",
				}
			: { error: feedback.error, fix: feedback.fix },
		tokenPresent: Boolean(token),
	};
}

function sendingStep(entry: SendingPlanEntry): StepSpec {
	const sd = entry.target.sendingDomain;
	return {
		id: `sending:${sd}`,
		deps: [],
		run: async () => {
			const decide = async () =>
				decideSendingTarget({
					env,
					entry,
					dmarc: manifest.dmarc,
					observed: await observeSending(entry),
				});
			return settle(await decide(), mode, async (plan) => {
				console.log(`\n── sending:${sd}: pnpm ${plan.args.join(" ")}`);
				try {
					execFileSync("pnpm", plan.args, { stdio: "inherit" });
				} catch (error) {
					const status = (error as { status?: number }).status;
					return {
						state: "failed",
						error: `setup:sending exited with status ${status ?? "?"} (its output is above).`,
					};
				}
				readSendingList.reset();
				readFeedback.reset();
				const after = await decide();
				if (after.state === "already")
					return { state: "done", detail: `setup:sending converged ${after.detail}` };
				if (after.state === "todo") {
					const dnsOnly = after.plan.missing.every((m) => /^(SPF|DKIM|MX|DMARC) /.test(m));
					if (dnsOnly) {
						// Public resolvers cache the NXDOMAIN they saw before the write
						// (negative TTL), so fresh records can lag. setup:sending exited 0.
						return {
							state: "done",
							detail: `setup:sending --apply exited 0; public DNS does not show yet: ${after.plan.missing.join("; ")} — re-run onboard in a few minutes to confirm.`,
						};
					}
					return {
						state: "failed",
						error: `setup:sending ran, but ${sd} still needs: ${after.plan.missing.join("; ")}`,
					};
				}
				return {
					state: "failed",
					error: after.state === "blocked" ? after.reason : "unexpected state",
				};
			});
		},
	};
}

/** Addresses that must be allowed to send when EMAIL.allowed_sender_addresses is bounded. */
const requiredSenders = [
	...new Set([manifest.mailbox.address, ...manifest.keys.map((key) => key.sender)]),
].sort();

function planConfig() {
	const result = planSendingConfigUpdate({
		tracked,
		generated: readGeneratedConfig(env),
		env,
		addDomains: sendingDomains,
		fromAddress: `hello@${sendingDomains[0]}`,
		addSenders: requiredSenders,
	});
	if (!result.ok)
		throw new Error(
			`${result.error} in ${existsSync(generatedPath) ? generatedPath : "wrangler.jsonc"}`,
		);
	return result.value;
}

const configStep: StepSpec = {
	id: "config:MAIL_SENDING_DOMAINS",
	deps: manifest.sending.map((entry) => `sending:${entry.target.sendingDomain}`),
	run: async () =>
		settle(decideSendingConfig(planConfig(), generatedPath), mode, async () => {
			const update = planConfig();
			writeFileSync(generatedPath, `${JSON.stringify(update.config, null, 2)}\n`);
			const shipped = parseDomainList(
				deployedVars(tracked, readGeneratedConfig(env), env).MAIL_SENDING_DOMAINS,
			);
			const lacking = sendingDomains.filter((domain) => !shipped.includes(domain));
			if (lacking.length > 0) {
				return {
					state: "failed",
					error: `wrote ${generatedPath}, but a deploy would still lack ${lacking.join(", ")}.`,
				};
			}
			return {
				state: "done",
				detail: `wrote ${generatedPath}: MAIL_SENDING_DOMAINS=${update.sendingDomains.join(",")}.`,
			};
		}),
};

const deployedStep: StepSpec = {
	id: "deployed:MAIL_SENDING_DOMAINS",
	deps: [configStep.id],
	run: async () => {
		const status = wranglerCapture(["deployments", "status", "--name", worker, "--json"]);
		const versionIds = status.ok ? parseDeploymentStatus(status.out) : null;
		let live: Array<{ versionId: string; domains: string[] }> | null = null;
		let liveError = status.ok ? undefined : firstLine(status.err);
		if (versionIds) {
			live = [];
			for (const versionId of versionIds) {
				const view = wranglerCapture(["versions", "view", versionId, "--name", worker, "--json"]);
				const vars = view.ok ? parseVersionVars(view.out) : null;
				if (!vars) {
					live = null;
					liveError = `could not read version ${versionId}${view.ok ? "" : `: ${firstLine(view.err)}`}`;
					break;
				}
				live.push({ versionId, domains: parseDomainList(vars.MAIL_SENDING_DOMAINS) });
			}
		}
		return settle(
			decideDeployedDomains({ env, worker, targets: sendingDomains, live, liveError }),
			mode,
			async () => ({ state: "failed", error: "onboard never deploys" }),
		);
	},
};

const routingEnableStep: StepSpec = {
	id: "routing:enable",
	deps: [],
	run: async () =>
		settle(decideRoutingEnabled(zone, await readRoutingSettings()), mode, async () => {
			const out = wranglerCapture(["email", "routing", "enable", zone]);
			if (!out.ok && !/already/i.test(`${out.out}\n${out.err}`)) {
				return {
					state: "failed",
					error: `wrangler email routing enable ${zone}: ${firstLine(out.err)}`,
				};
			}
			readRoutingSettings.reset();
			const after = decideRoutingEnabled(zone, await readRoutingSettings());
			if (after.state === "already")
				return { state: "done", detail: `enabled Email Routing on ${zone}.` };
			if (after.state === "blocked") {
				return {
					state: "done",
					detail: `enabled Email Routing on ${zone}; ${after.reason} ${after.remedy}`,
				};
			}
			return {
				state: "failed",
				error: `Email Routing on ${zone} still reads as disabled after enabling.`,
			};
		}),
};

function routingRuleStep(address: string): StepSpec {
	return {
		id: `routing:${address}`,
		deps: [routingEnableStep.id],
		run: async () => {
			const decide = async () =>
				decideRoutingRule({ zone, address, worker, rules: await readRoutingRules() });
			return settle(await decide(), mode, async (plan) => {
				const out = wranglerCapture(plan.args);
				if (!out.ok)
					return { state: "failed", error: `rule create for ${address}: ${firstLine(out.err)}` };
				readRoutingRules.reset();
				const after = await decide();
				if (after.state === "already") return { state: "done", detail: `created ${after.detail}` };
				return {
					state: "failed",
					error: `created a rule for ${address}, but it does not read back as to:${address} -> worker:${worker}.`,
				};
			});
		},
	};
}

const domainStep: StepSpec = {
	id: "domain",
	deps: [],
	run: () =>
		guarded(async () => {
			const domains = await readDomains();
			const registered = domains.some((d) => d.domain.toLowerCase() === zone);
			const zoneId = await discoverZoneId(!registered);
			return settle(
				decideDomain({ zone, domains, zoneId: zoneId.id, zoneIdSource: zoneId.source }),
				mode,
				async (plan) => {
					const result = await api<{ domain: DomainRowLike | null; created: boolean }>(
						"/api/domains",
						{
							method: "POST",
							body: { domain: zone, zoneId: plan.zoneId },
						},
					);
					readDomains.reset();
					return {
						state: "done",
						detail: `${result.created ? "registered" : "found"} ${zone} (zone ${result.domain?.zone_id ?? plan.zoneId}).`,
					};
				},
			);
		}),
};

const mailboxStep: StepSpec = {
	id: "mailbox",
	deps: [domainStep.id],
	run: () =>
		guarded(async () => {
			const decision = decideMailbox({
				address: manifest.mailbox.address,
				displayName: manifest.mailbox.displayName,
				mailboxes: await readMailboxes(),
				aliases: await readAliases(),
				sessionEmail: session?.email,
			});
			return settle(decision, mode, async (plan) => {
				const createBody = {
					primaryAddress: manifest.mailbox.address,
					...(manifest.mailbox.displayName ? { displayName: manifest.mailbox.displayName } : {}),
				};
				let mailboxId: string | undefined;
				const did: string[] = [];
				if (plan.kind === "create" || plan.repostForPrimaryAlias) {
					const result = await api<{ mailbox: MailboxRowLike | null; created: boolean }>(
						"/api/mailboxes",
						{
							method: "POST",
							body: createBody,
						},
					);
					mailboxId = result.mailbox?.mailbox_id;
					did.push(
						result.created
							? `created mailbox ${mailboxId}`
							: `converged mailbox ${mailboxId}'s primary alias`,
					);
				}
				if (plan.kind === "converge") {
					mailboxId = plan.mailboxId;
					if (plan.displayName) {
						await api(`/api/mailboxes/${plan.mailboxId}`, {
							method: "PATCH",
							body: { displayName: plan.displayName },
						});
						did.push(`set displayName "${plan.displayName}"`);
					}
				}
				readMailboxes.reset();
				readAliases.reset();
				const after = decideMailbox({
					address: manifest.mailbox.address,
					displayName: manifest.mailbox.displayName,
					mailboxes: await readMailboxes(),
					aliases: await readAliases(),
					sessionEmail: session?.email,
				});
				if (after.state !== "already") {
					return {
						state: "failed",
						error: `${did.join("; ")}, but the mailbox still reads as: ${after.state === "todo" ? after.action : after.reason}`,
					};
				}
				return { state: "done", detail: `${did.join("; ")} for ${manifest.mailbox.address}.` };
			});
		}),
};

function aliasStep(alias: string): StepSpec {
	return {
		id: `alias:${alias}`,
		deps: [mailboxStep.id],
		run: () =>
			guarded(async () => {
				const mailboxId = await currentMailboxId();
				return settle(
					decideAlias({ alias, mailboxId, aliases: await readAliases() }),
					mode,
					async () => {
						if (!mailboxId)
							return {
								state: "failed",
								error: "the mailbox id is unknown after the mailbox step.",
							};
						await api("/api/aliases", { method: "POST", body: { aliasAddress: alias, mailboxId } });
						readAliases.reset();
						const after = decideAlias({ alias, mailboxId, aliases: await readAliases() });
						return after.state === "already"
							? { state: "done", detail: `created ${after.detail}` }
							: { state: "failed", error: `POST /api/aliases for ${alias} did not read back.` };
					},
				);
			}),
	};
}

async function readTemplates(mailboxId: string | undefined): Promise<ExistingTemplate[]> {
	if (!mailboxId) return [];
	return (
		await api<{ templates: ExistingTemplate[] }>(
			`/api/mailboxes/${mailboxId}/transactional/templates`,
		)
	).templates;
}

const templatesStep: StepSpec | null =
	manifest.templates && templates
		? {
				id: "templates",
				deps: [mailboxStep.id],
				run: () =>
					guarded(async () => {
						const desired = templates ?? [];
						const archiveMissing = manifest.templates?.archiveMissing ?? false;
						const mailboxId = await currentMailboxId();
						const diff = diffTemplates(desired, await readTemplates(mailboxId), archiveMissing);
						return settle(
							decideTemplates({
								mailboxId,
								file: manifest.templates?.file ?? "",
								diff,
								archiveMissing,
							}),
							mode,
							async () => {
								if (!mailboxId)
									return {
										state: "failed",
										error: "the mailbox id is unknown after the mailbox step.",
									};
								const result = await api<{ results: TemplateSyncResult[] }>(
									`/api/mailboxes/${mailboxId}/transactional/templates`,
									{ method: "PUT", body: { templates: desired, archiveMissing } },
								);
								return interpretTemplateSync(result.results ?? []);
							},
						);
					}),
			}
		: null;

// --- Telegram topic -----------------------------------------------------------

/**
 * GET /api/telegram/status reduced to the step's inputs. The route calls
 * Telegram read-only (getMe/getChat/getChatMember), so a dry run stays a read.
 */
async function observeTelegramTopic(): Promise<TelegramTopicObservation> {
	const status = await api<TelegramOperatorStatus>("/api/telegram/status");
	const topic =
		status.mailboxes.find((m) => m.address.toLowerCase() === manifest.mailbox.address)?.topic ??
		null;
	return {
		bridgeOn: status.bot !== null,
		chatId: status.binding.chatId,
		isForum: status.chat?.ok ? status.chat.isForum : status.binding.isForum,
		canManageTopics: status.membership?.ok ? status.membership.canManageTopics : null,
		mapping: topic
			? { topicId: topic.topicId, topicName: topic.topicName, effectiveName: topic.effectiveName }
			: null,
	};
}

const telegramTopicStep: StepSpec | null = manifest.telegram
	? {
			id: "telegram:topic",
			deps: [mailboxStep.id],
			run: () =>
				guarded(async () => {
					const spec = manifest.telegram ?? {};
					const decide = async () =>
						decideTelegramTopic({
							spec,
							address: manifest.mailbox.address,
							displayName: manifest.mailbox.displayName,
							observed: await observeTelegramTopic(),
						});
					return settle(await decide(), mode, async (plan) => {
						const mailboxId = await currentMailboxId();
						if (!mailboxId) {
							return {
								state: "failed",
								error: "the mailbox id is unknown after the mailbox step.",
							};
						}
						const result = await api<TopicMappingResult>("/api/telegram/topics", {
							method: "POST",
							body: { mailboxId, ...plan },
						});
						const after = await decide();
						if (after.state !== "already") {
							return {
								state: "failed",
								error: `POST /api/telegram/topics answered ${result.outcome}, but the mapping still reads as: ${after.state === "todo" ? after.action : after.reason}`,
							};
						}
						return {
							state: "done",
							detail: `${result.outcome} ${after.detail}${result.topicVerified ? "" : " Verify with pnpm smoke:telegram."}`,
						};
					});
				}),
		}
	: null;

// --- API keys + 1Password ----------------------------------------------------

type OpResult = { ok: true; out: string } | { ok: false; err: string };

function op(argv: string[]): OpResult {
	try {
		const out = execFileSync("op", argv, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, out };
	} catch (error) {
		const stderr = (error as { stderr?: unknown }).stderr;
		const code = (error as { code?: string }).code;
		return {
			ok: false,
			err:
				code === "ENOENT"
					? "the 1Password CLI (op) is not installed"
					: scrub(typeof stderr === "string" ? firstLine(stderr) : String(error)),
		};
	}
}

/**
 * `op item create --template <file>` from a 0600 file in a fresh 0700 temp dir,
 * removed in `finally` — the same shape as the manual flow. Piping the JSON on
 * stdin (`op item create -`) would avoid the file, but op only reads stdin when it
 * is a FIFO, and Node's child stdio pipe is a socket: op silently ignores it and
 * creates an empty "Untitled" item (checked with `op item create --dry-run`).
 * Passing the secret as an assignment argument would put it in argv instead.
 */
function opCreateFromTemplate(vault: string, itemJson: string): OpResult {
	const dir = mkdtempSync(join(tmpdir(), "reccado-onboard-"));
	const file = join(dir, "item.json");
	try {
		chmodSync(dir, 0o700);
		writeFileSync(file, itemJson, { mode: 0o600, flag: "wx" });
		return op(["item", "create", "--template", file, "--vault", vault, "--format", "json"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Reads ONLY the item's `key id` and RECCADO_ENDPOINT fields — never the credential. */
function opField(itemId: string, vault: string, label: string): string | undefined {
	const got = op([
		"item",
		"get",
		itemId,
		"--vault",
		vault,
		"--fields",
		`label=${label}`,
		"--format",
		"json",
	]);
	if (!got.ok) return undefined;
	try {
		return parseOpFields(got.out)[label];
	} catch {
		return undefined;
	}
}

function observeStore(key: ManifestKey): KeyStoreObservation {
	const store = key.store?.onePassword;
	if (!store) return { kind: "none" };
	const listed = op(["item", "list", "--vault", store.vault, "--format", "json"]);
	if (!listed.ok) return { kind: "unavailable", reason: listed.err };
	let ids: string[];
	try {
		ids = findItemsByTitle(listed.out, store.title);
	} catch (error) {
		return { kind: "unavailable", reason: (error as Error).message };
	}
	if (ids.length === 0) return { kind: "absent" };
	if (ids.length > 1) return { kind: "ambiguous", itemIds: ids };
	const itemId = ids[0] ?? "";
	return {
		kind: "present",
		itemId,
		keyId: opField(itemId, store.vault, "key id"),
		endpoint: opField(itemId, store.vault, "RECCADO_ENDPOINT"),
	};
}

const keyStorage: string[] = [];

function keyStep(key: ManifestKey): StepSpec {
	const body = keyBodies.get(key.name);
	const store = key.store?.onePassword;
	const storeLabel = store ? `${store.vault}/"${store.title}"` : undefined;
	return {
		id: `key:${key.name}`,
		deps: [
			mailboxStep.id,
			...(templatesStep ? [templatesStep.id] : []),
			`sending:${key.sender.slice(key.sender.lastIndexOf("@") + 1)}`,
		],
		run: () =>
			guarded(async () => {
				if (!body) return { state: "failed", error: `no resolved body for key ${key.name}` };
				const mailboxId = await currentMailboxId();
				const keys = mailboxId
					? (
							await api<{ keys: ApiKeyEntry[] }>(
								`/api/mailboxes/${mailboxId}/transactional/api-keys`,
							)
						).keys
					: null;
				const endpoint = mailboxId ? endpointFor(origin, mailboxId) : undefined;
				const observed = observeStore(key);
				const decision = decideKey({
					name: key.name,
					body,
					store: observed,
					storeLabel,
					keys,
					mailboxId,
					endpoint,
				});
				if (decision.state === "already" && observed.kind === "present") {
					keyStorage.push(
						`${key.name}: key ${observed.keyId} in 1Password ${storeLabel} (item ${observed.itemId})`,
					);
				}
				return settle(decision, mode, async (plan) => {
					if (!mailboxId || !endpoint || !store) {
						return { state: "failed", error: "mailbox id or store unknown at apply time." };
					}
					if (plan.kind === "fix") {
						const did: string[] = [];
						if (plan.senderName !== undefined) {
							await api(`/api/mailboxes/${mailboxId}/transactional/api-keys/${plan.keyId}`, {
								method: "PATCH",
								body: { senderName: plan.senderName },
							});
							did.push(`senderName -> ${JSON.stringify(plan.senderName)}`);
						}
						if (plan.endpoint) {
							const edited = op([
								"item",
								"edit",
								plan.itemId,
								"--vault",
								store.vault,
								`RECCADO_ENDPOINT=${plan.endpoint}`,
								"--format",
								"json",
							]);
							if (!edited.ok)
								return { state: "failed", error: `op item edit ${plan.itemId}: ${edited.err}` };
							did.push("RECCADO_ENDPOINT updated");
						}
						keyStorage.push(
							`${key.name}: key ${plan.keyId} in 1Password ${storeLabel} (item ${plan.itemId})`,
						);
						return { state: "done", detail: `key ${plan.keyId}: ${did.join("; ")}.` };
					}
					return mintKey({
						key,
						body,
						mailboxId,
						endpoint,
						vault: store.vault,
						title: store.title,
						storeLabel: storeLabel ?? "",
					});
				});
			}),
	};
}

async function mintKey(opts: {
	key: ManifestKey;
	body: KeyCreateBody;
	mailboxId: string;
	endpoint: string;
	vault: string;
	title: string;
	storeLabel: string;
}): Promise<OnboardOutcome> {
	const { key, body, mailboxId, endpoint } = opts;
	// Re-check the store immediately before minting: the one thing that must never
	// happen is a second key minted next to one that is already stored.
	const recheck = observeStore(key);
	if (recheck.kind !== "absent") {
		return {
			state: "failed",
			error: `1Password ${opts.storeLabel} changed since it was read (${recheck.kind}); not minting.`,
		};
	}
	const created = await api<{
		key?: { keyId?: string; displaySuffix?: string };
		plaintextKey?: string;
	}>(`/api/mailboxes/${mailboxId}/transactional/api-keys`, { method: "POST", body });
	const plaintext = created.plaintextKey;
	const keyId = created.key?.keyId;
	if (plaintext) secrets.push(plaintext);
	if (!plaintext || !keyId) {
		return { state: "failed", error: "the create response carried no key id / plaintext." };
	}
	const sender = body.senderName ? `${body.senderName} <${body.sender}>` : body.sender;
	const notes = [
		`Reccado transactional API key "${key.name}" (${body.environment}) for ${manifest.mailbox.address} (mailbox ${mailboxId}) on ${host}.`,
		`Sender: ${sender}. Scopes: ${body.scopes.join(", ")}.`,
		body.recipientPolicy ? `Recipient policy: ${body.recipientPolicy}.` : "",
		body.quotaMax ? `Quota: ${body.quotaMax}.` : "",
		`Created by pnpm onboard on ${new Date().toISOString().slice(0, 10)}.`,
		key.store?.onePassword.notes ?? "",
	]
		.filter(Boolean)
		.join("\n");
	const item = buildOnePasswordItem({
		title: opts.title,
		plaintextKey: plaintext,
		endpoint,
		keyId,
		notes,
	});
	const stored = opCreateFromTemplate(opts.vault, JSON.stringify(item));
	if (!stored.ok) {
		// A key whose secret was stored nowhere is a lost key; do not leave it live.
		let revoked = "and could NOT be revoked — revoke it by hand";
		try {
			await api(`/api/mailboxes/${mailboxId}/transactional/api-keys/${keyId}/revoke`, {
				method: "POST",
			});
			revoked = "so it was revoked";
		} catch {
			// Reported below.
		}
		return {
			state: "failed",
			error: `minted key ${keyId}, but storing it in 1Password ${opts.storeLabel} failed (${stored.err}), ${revoked}.`,
		};
	}
	let itemId = "";
	try {
		itemId = String((JSON.parse(stored.out) as { id?: unknown }).id ?? "");
	} catch {
		// Verified by title below.
	}
	const back = observeStore(key);
	if (back.kind !== "present" || back.keyId !== keyId) {
		return {
			state: "failed",
			error: `minted key ${keyId} and ran op item create, but 1Password ${opts.storeLabel} does not read back with that key id (${back.kind}).`,
		};
	}
	keyStorage.push(
		`${key.name}: key ${keyId} in 1Password ${opts.storeLabel} (item ${itemId || back.itemId})`,
	);
	return {
		state: "done",
		detail: `minted key ${keyId}${created.key?.displaySuffix ? ` (…${created.key.displaySuffix})` : ""}; plaintext stored only in 1Password ${opts.storeLabel}.`,
	};
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const steps: StepSpec[] = [
	...manifest.sending.map(sendingStep),
	configStep,
	deployedStep,
	routingEnableStep,
	...[manifest.mailbox.address, ...manifest.mailbox.aliases].map(routingRuleStep),
	domainStep,
	mailboxStep,
	...manifest.mailbox.aliases.map(aliasStep),
	...(templatesStep ? [templatesStep] : []),
	...(telegramTopicStep ? [telegramTopicStep] : []),
	...manifest.keys.map(keyStep),
];

console.log(
	`\nReccado onboard — ${mode === "apply" ? "APPLY" : "dry run (reads only; nothing is written)"}` +
		`\n  manifest: ${manifestPath}` +
		`\n  env: ${env ?? "production"} · worker: ${worker} · host: ${host}` +
		`\n  zone: ${zone} · sending: ${sendingDomains.join(", ")}` +
		`\n  mailbox: ${manifest.mailbox.address}${manifest.mailbox.aliases.length ? ` + ${manifest.mailbox.aliases.join(", ")}` : ""}` +
		`\n  session: ${session ? `${session.email ?? "?"} (label ${session.label})` : (sessionProblem ?? "none")}` +
		`\n  CLOUDFLARE_API_TOKEN: ${token ? "set" : "not set"}\n`,
);
for (const warning of manifest.warnings) console.warn(`WARNING: ${warning}`);

const idWidth = Math.min(48, Math.max(4, ...steps.map((step) => step.id.length)));

const results = await runSteps(
	steps,
	mode,
	(result) => {
		for (const line of formatResults([result], idWidth)) console.log(line);
	},
	(error) => {
		if (error instanceof OperatorHttpError)
			return scrub(`HTTP ${error.status} on ${error.path}: ${error.body.slice(0, 300)}`);
		if (error instanceof OperatorInputError) return scrub(error.message);
		return scrub(error instanceof Error ? error.message : String(error));
	},
);

const counts = tally(results);
console.log(`\n${"─".repeat(72)}\nSummary (${mode}):`);
for (const line of formatResults(results)) console.log(line);
console.log(
	`\n  ${Object.entries(counts)
		.filter(([, n]) => n > 0)
		.map(([state, n]) => `${n} ${state.replace("_", " ")}`)
		.join(" · ")}`,
);

const mailboxIdAtEnd = session ? await currentMailboxIdSafe() : undefined;
console.log(
	`\n  RECCADO_ENDPOINT: ${mailboxIdAtEnd ? endpointFor(origin, mailboxIdAtEnd) : `${origin}/v1/mailboxes/<mailbox id>/transactional/messages (mailbox not created yet)`}`,
);
if (manifest.keys.length > 0) {
	console.log("  Keys:");
	if (keyStorage.length === 0) console.log("    (none stored yet)");
	for (const line of keyStorage) console.log(`    ${line}`);
}

const generatedAfter = existsSync(generatedPath) ? readFileSync(generatedPath, "utf8") : null;
const configChanged = generatedAfter !== generatedBefore;
const configWouldChange = results.some(
	(r) => r.id === configStep.id && r.outcome.state === "would_do",
);
const deployBlocked = results.some(
	(r) => r.id === deployedStep.id && r.outcome.state === "blocked",
);
if (configChanged || configWouldChange || deployBlocked) {
	const deploy = deployCommandFor(env);
	console.log(
		`\n  Deploy required: replies and keys only send as ${sendingDomains.join(", ")} once the Worker ships ` +
			`MAIL_SENDING_DOMAINS from ${generatedPath}${configChanged ? " (changed by this run)" : configWouldChange ? " (after --apply writes it)" : ""}. Onboard never deploys:` +
			`\n    ${deploy} --dry-run   # prints the overlay + bindings, uploads nothing` +
			`\n    ${deploy}`,
	);
}
if (mode === "dry-run")
	console.log('\nDry run only. Re-run with --apply to perform the "would do" steps.');
console.log("");

async function currentMailboxIdSafe(): Promise<string | undefined> {
	try {
		readMailboxes.reset();
		return await currentMailboxId();
	} catch {
		return undefined;
	}
}

process.exit(exitCodeFor(results));
