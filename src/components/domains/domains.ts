/**
 * Frontend contract for domain provisioning.
 *
 * Backend reality this mirrors (src/api/hono.ts + src/lib/provision.ts):
 *   GET  /api/domains                      -> { domains: DomainRow[] }
 *   GET  /api/domains/:domain/status       -> { domain, cloudflare }
 *   POST /api/domains/:domain/provision    -> ProvisionResult
 *
 * The provision endpoint answers 200 even when steps did not succeed, because
 * the useful information is WHICH step is blocked. So this client treats a
 * non-2xx as a request that never ran, and a 200 with blocked steps as a normal
 * result to be rendered — not as an error.
 */

export type StepName =
	| "register_domain"
	| "email_sending"
	| "dmarc"
	| "email_routing"
	| "feedback_subscription"
	| "mailbox";

export type StepState = "already" | "done" | "skipped" | "blocked" | "failed";

export type StepOutcome =
	| { state: "already"; detail: string }
	| { state: "done"; detail: string }
	| { state: "skipped"; reason: string }
	| { state: "blocked"; reason: string; remedy: string }
	| { state: "failed"; error: string };

export type ProvisionStep = { name: StepName; outcome: StepOutcome };

export type ProvisionResult = {
	zone: string;
	sendingDomain: string;
	steps: ProvisionStep[];
	complete: boolean;
};

export type Domain = {
	id: string;
	domain: string;
	zone_id: string;
	status: "pending" | "active" | "disabled";
	created_at?: string;
	updated_at?: string;
};

export type DmarcPolicy = "none" | "quarantine" | "reject";

export type ProvisionInput = {
	subdomain: string;
	dmarc: { policy: DmarcPolicy; alignment?: "relaxed" | "strict"; rua?: string };
	inbound: boolean;
	mailbox?: { address: string; displayName?: string; ownerEmail?: string };
};

/** What each step is for, in the operator's terms rather than Cloudflare's. */
export const STEP_LABELS: Record<StepName, { title: string; blurb: string }> = {
	register_domain: {
		title: "Register the zone in Reccado",
		blurb: "Records Reccado's authority over this zone. Nothing else can write DNS without it.",
	},
	email_sending: {
		title: "Email Sending",
		blurb: "Cloudflare provisions DKIM, SPF, MX and return-path records for the subdomain.",
	},
	dmarc: {
		title: "Publish DMARC",
		blurb: "Replaces Cloudflare's default p=reject with the policy you chose.",
	},
	email_routing: {
		title: "Receive mail",
		blurb: "Turns on Cloudflare Email Routing for the zone.",
	},
	feedback_subscription: {
		title: "Delivery feedback",
		blurb: "Without it, bounces and complaints are published and lost, and nothing says so.",
	},
	mailbox: { title: "Create the mailbox", blurb: "The mailbox that receives and sends on it." },
};

/** Step title with the concrete names filled in ("Email Sending on send.example.com"). */
export function stepTitle(
	name: StepName,
	ctx: { sendingDomain?: string; mailbox?: string },
): string {
	if (name === "email_sending" && ctx.sendingDomain) return `Email Sending on ${ctx.sendingDomain}`;
	if (name === "mailbox" && ctx.mailbox) return `Create ${ctx.mailbox}`;
	return STEP_LABELS[name].title;
}

export const DMARC_LABELS: Record<DmarcPolicy, string> = {
	none: "Monitor",
	quarantine: "Quarantine",
	reject: "Reject",
};

export class DomainError extends Error {
	readonly code: string;
	readonly status: number;
	readonly fieldErrors: Record<string, string[]>;

	constructor(
		code: string,
		status: number,
		opts: { message?: string; fieldErrors?: Record<string, string[]> } = {},
	) {
		super(opts.message ?? code);
		this.name = "DomainError";
		this.code = code;
		this.status = status;
		this.fieldErrors = opts.fieldErrors ?? {};
	}
}

export function asDomainError(error: unknown): DomainError {
	if (error instanceof DomainError) return error;
	return new DomainError("network_error", 0, {
		message: error instanceof Error ? error.message : "Request failed",
	});
}

export function explainDomainError(error: DomainError): string | null {
	switch (error.code) {
		case "mailbox_outside_zone":
			return "The mailbox address must be on the domain you are provisioning — inbound routing is enabled on this zone only.";
		case "domain_not_found":
			return "That domain is not registered yet.";
		case "unauthorized":
			return "Your session expired. Sign in again at /login.";
		case "network_error":
			return "The request never reached the worker. Check your connection and retry.";
		case "validation_error":
			return "Some fields were not accepted. Check them and try again.";
		case "mailbox_not_found":
			return "That mailbox no longer exists.";
		case "alias_not_found":
			return "That alias no longer exists.";
		case "routing_rule_not_found":
			return "That rule no longer exists.";
		case "mailbox_id_required":
			return "A “store” rule needs a mailbox.";
		case "forward_to_required":
			return "A “forward” rule needs at least one destination.";
		case "origin_mismatch":
			return "The request came from another origin and was refused.";
		default:
			return null;
	}
}

async function readError(res: Response): Promise<DomainError> {
	let code = `http_${res.status}`;
	let message: string | undefined;
	let fieldErrors: Record<string, string[]> | undefined;
	try {
		const body = (await res.json()) as {
			error?: unknown;
			code?: unknown;
			message?: unknown;
			issues?: { fieldErrors?: unknown };
		};
		if (typeof body.error === "string" && body.error) code = body.error;
		else if (typeof body.code === "string" && body.code) code = body.code;
		if (typeof body.message === "string") message = body.message;
		const issues = body.issues;
		if (issues?.fieldErrors && typeof issues.fieldErrors === "object") {
			fieldErrors = issues.fieldErrors as Record<string, string[]>;
		}
	} catch {
		// Non-JSON body: the status code stands.
	}
	return new DomainError(code, res.status, { message, fieldErrors });
}

export async function json<T>(res: Response): Promise<T> {
	if (!res.ok) throw await readError(res);
	return (await res.json()) as T;
}

export async function fetchDomains(): Promise<Domain[]> {
	const data = await json<{ domains?: Domain[] }>(await fetch("/api/domains"));
	return data.domains ?? [];
}

export async function provisionDomain(
	domain: string,
	input: ProvisionInput,
): Promise<ProvisionResult> {
	return json<ProvisionResult>(
		await fetch(`/api/domains/${encodeURIComponent(domain)}/provision`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		}),
	);
}

// ---------------------------------------------------------------------------
// Settings screen: mailboxes, aliases, routing rules, Cloudflare reads
// ---------------------------------------------------------------------------

export type Mailbox = {
	mailbox_id: string;
	primary_address: string;
	display_name: string | null;
	status: "active" | "disabled";
	owner_email: string | null;
	created_at: string;
	updated_at: string;
};

export type Alias = {
	alias_address: string;
	mailbox_id: string;
	domain_id: string;
	status: "active" | "disabled";
	created_at: string;
	updated_at: string;
};

export type RuleAction = "store" | "forward" | "reject";

export type RoutingRule = {
	id: string;
	domain_id: string;
	pattern: string;
	priority: number;
	action: RuleAction;
	mailbox_id: string | null;
	forward_to_json: string;
	reject_reason: string | null;
	enabled: number;
	created_at: string;
	updated_at: string;
};

export type ReadFailure = {
	ok: false;
	reason: "token_missing" | "permission" | "timeout" | "error";
	message: string;
};

export type ZoneListing =
	| {
			ok: true;
			zones: Array<{ id: string; name: string }>;
			total: number;
			registered: number;
			truncated: boolean;
	  }
	| ReadFailure;

export type AddressRouting =
	| { address: string; state: "routed"; via: "rule" | "catch_all"; workers: string[] }
	| { address: string; state: "elsewhere"; via: "rule" | "catch_all"; action: string }
	| { address: string; state: "not_routed" }
	| { address: string; state: "unknown" };

export type FeedbackState = "live" | "unobserved" | "never_observed" | "went_dark";

export type DomainOverview = {
	domain: string;
	sending: { ok: true; subdomains: string[] } | ReadFailure;
	dmarc:
		| {
				ok: true;
				records: Array<{ sendingDomain: string; policy: string | null; record: string | null }>;
		  }
		| ReadFailure;
	inbound: { ok: true; enabled: boolean } | ReadFailure;
	routing:
		| { ok: true; enabled: boolean; addresses: AddressRouting[]; catchAll: AddressRouting }
		| (ReadFailure & { addresses: AddressRouting[]; catchAll: AddressRouting });
	feedback: Array<{
		domain: string;
		state: FeedbackState;
		lastEventAt: string | null;
		reason: string | null;
	}>;
};

export type DomainCloudflareStatus = {
	domain: Domain;
	cloudflare:
		| { configured: false; reason: string }
		| {
				configured: true;
				ok: boolean;
				reason: string | null;
				status: string | null;
				name: string | null;
		  };
};

export type FeedbackHealth = {
	mode: string;
	darkDomains: string[];
	reason: string | null;
};

export type CreateMailboxResult = {
	mailbox: Mailbox | null;
	created: boolean;
	alias: Alias | null;
	aliasCreated: boolean;
	aliasReason: string | null;
};

const enc = encodeURIComponent;

function send(method: string, url: string, body?: unknown): Promise<Response> {
	return fetch(url, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
	try {
		return await json<T>(await send(method, url, body));
	} catch (caught) {
		throw asDomainError(caught);
	}
}

export async function fetchMailboxes(): Promise<Mailbox[]> {
	return (await call<{ mailboxes?: Mailbox[] }>("GET", "/api/mailboxes")).mailboxes ?? [];
}

export async function fetchAliases(): Promise<Alias[]> {
	return (await call<{ aliases?: Alias[] }>("GET", "/api/aliases")).aliases ?? [];
}

export async function fetchRoutingRules(): Promise<RoutingRule[]> {
	return (await call<{ rules?: RoutingRule[] }>("GET", "/api/routing-rules")).rules ?? [];
}

/** Feedback liveness, from `/api/health` (no Cloudflare token needed). */
export async function fetchFeedbackHealth(): Promise<FeedbackHealth | null> {
	const body = await call<{
		dependencies?: {
			sendingFeedback?: { mode?: string; darkDomains?: string[]; reason?: string | null };
		};
	}>("GET", "/api/health");
	const sf = body.dependencies?.sendingFeedback;
	if (!sf) return null;
	return {
		mode: sf.mode ?? "unknown",
		darkDomains: sf.darkDomains ?? [],
		reason: sf.reason ?? null,
	};
}

export function fetchZones(): Promise<ZoneListing> {
	return call<ZoneListing>("GET", "/api/cloudflare/zones");
}

export function fetchDomainOverview(domain: string): Promise<DomainOverview> {
	return call<DomainOverview>("GET", `/api/cloudflare/domains/${enc(domain)}/overview`);
}

export function fetchDomainStatus(domain: string): Promise<DomainCloudflareStatus> {
	return call<DomainCloudflareStatus>("GET", `/api/domains/${enc(domain)}/status`);
}

export function setDomainStatus(domain: string, status: Domain["status"]): Promise<unknown> {
	return call("PATCH", `/api/domains/${enc(domain)}`, { status });
}

/**
 * `POST /api/cloudflare/domains/:domain/routing` — the server-side "Route it".
 * A refusal is a normal answer (`ok: false` with a reason and remedy), not a
 * thrown error; only a request that never got a routing answer (session,
 * network, CSRF) throws.
 */
export type RouteRefusalReason =
	| "invalid_address"
	| "domain_not_found"
	| "domain_inactive"
	| "address_unknown"
	| "token_missing"
	| "worker_unknown"
	| "permission"
	| "routing_disabled"
	| "conflict"
	| "timeout"
	| "cloudflare_error";

export type RouteAddressResult =
	| {
			ok: true;
			status: "created" | "already";
			address: string;
			worker: string;
			via: "rule" | "catch_all";
			ruleId: string | null;
	  }
	| {
			ok: false;
			reason: RouteRefusalReason;
			address: string;
			message: string;
			remedy: string;
			cli?: string;
	  };

export async function routeAddress(address: string): Promise<RouteAddressResult> {
	const res = await send("POST", `/api/cloudflare/domains/${enc(domainOf(address))}/routing`, {
		address,
	}).catch((caught: unknown) => {
		throw asDomainError(caught);
	});
	const body = (await res
		.clone()
		.json()
		.catch(() => null)) as { ok?: unknown } | null;
	if (body && typeof body.ok === "boolean") return body as RouteAddressResult;
	throw await readError(res);
}

export function createMailbox(input: {
	primaryAddress: string;
	displayName?: string;
}): Promise<CreateMailboxResult> {
	return call<CreateMailboxResult>("POST", "/api/mailboxes", input);
}

export function patchMailbox(
	mailboxId: string,
	patch: { displayName?: string | null; status?: Mailbox["status"] },
): Promise<unknown> {
	return call("PATCH", `/api/mailboxes/${enc(mailboxId)}`, patch);
}

export function createAlias(aliasAddress: string, mailboxId: string): Promise<unknown> {
	return call("POST", "/api/aliases", { aliasAddress, mailboxId });
}

export function deleteAlias(aliasAddress: string): Promise<unknown> {
	return call("DELETE", `/api/aliases/${enc(aliasAddress)}`);
}

export type RuleInput = {
	pattern: string;
	priority: number;
	action: RuleAction;
	mailboxId?: string | null;
	forwardTo?: string[];
	rejectReason?: string | null;
	enabled: boolean;
};

export function createRoutingRule(domainId: string, input: RuleInput): Promise<unknown> {
	return call("POST", "/api/routing-rules", {
		domainId,
		pattern: input.pattern,
		priority: input.priority,
		action: input.action,
		...(input.action === "store" && input.mailboxId ? { mailboxId: input.mailboxId } : {}),
		...(input.action === "forward" ? { forwardTo: input.forwardTo ?? [] } : {}),
		...(input.action === "reject" && input.rejectReason
			? { rejectReason: input.rejectReason }
			: {}),
		enabled: input.enabled,
	});
}

export function updateRoutingRule(ruleId: string, input: RuleInput): Promise<unknown> {
	return call("PATCH", `/api/routing-rules/${enc(ruleId)}`, {
		pattern: input.pattern,
		priority: input.priority,
		action: input.action,
		mailboxId: input.action === "store" ? (input.mailboxId ?? null) : null,
		forwardTo: input.action === "forward" ? (input.forwardTo ?? []) : [],
		rejectReason: input.action === "reject" ? input.rejectReason || null : null,
		enabled: input.enabled,
	});
}

export function deleteRoutingRule(ruleId: string): Promise<unknown> {
	return call("DELETE", `/api/routing-rules/${enc(ruleId)}`);
}

export function ruleForwardTo(rule: RoutingRule): string[] {
	try {
		const parsed = JSON.parse(rule.forward_to_json) as unknown;
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

/** Destinations whose domain is not one of the owner's registered domains. */
export function externalDestinations(addresses: string[], domains: Domain[]): string[] {
	const owned = new Set(domains.map((d) => d.domain.toLowerCase()));
	return addresses.filter((a) => !owned.has((a.split("@")[1] ?? "").toLowerCase()));
}

/** The domain part of an address, lowercased. */
export function domainOf(address: string): string {
	return (address.split("@")[1] ?? "").toLowerCase();
}

/** One human sentence for a failed Cloudflare read. */
export function explainReadFailure(failure: ReadFailure): string {
	switch (failure.reason) {
		case "token_missing":
			return "No Cloudflare API token is set on this Worker, so Cloudflare can't be checked from here.";
		case "permission":
			return "The Cloudflare token isn't allowed to read this.";
		case "timeout":
			return "Cloudflare didn't answer in time.";
		default:
			return failure.message;
	}
}
