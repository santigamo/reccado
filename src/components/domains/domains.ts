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
		title: "Register the zone",
		blurb: "Records Reccado's authority over this zone. Nothing else can write DNS without it.",
	},
	email_sending: {
		title: "Enable Email Sending",
		blurb: "Cloudflare provisions DKIM, SPF, MX and return-path records for the subdomain.",
	},
	dmarc: {
		title: "Publish the DMARC policy",
		blurb: "Replaces Cloudflare's default p=reject with the policy you chose below.",
	},
	email_routing: {
		title: "Enable inbound routing",
		blurb: "Lets the zone receive mail into a Reccado mailbox.",
	},
	feedback_subscription: {
		title: "Subscribe to delivery feedback",
		blurb: "Without it, bounces and complaints are published and lost, and nothing says so.",
	},
	mailbox: { title: "Create the mailbox", blurb: "The mailbox that receives and sends on it." },
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
			return "Your Cloudflare Access session expired. Reload the page to sign in again.";
		case "network_error":
			return "The request never reached the worker. Check your connection and retry.";
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

async function json<T>(res: Response): Promise<T> {
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

/** The one line that answers "did this work?" without hiding what did not. */
export function summarizeResult(result: ProvisionResult): string {
	if (result.complete) return `${result.sendingDomain} is fully provisioned.`;
	const stuck = result.steps.filter(
		(step) => step.outcome.state === "blocked" || step.outcome.state === "failed",
	);
	const skipped = result.steps.filter((step) => step.outcome.state === "skipped");
	if (stuck.length === 0 && skipped.length > 0) {
		return `${result.sendingDomain}: ${skipped.length} step(s) skipped.`;
	}
	return `${result.sendingDomain}: ${stuck.length} step(s) need attention. Re-running is safe — every step is idempotent.`;
}
