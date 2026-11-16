/**
 * "Route it": make Cloudflare Email Routing deliver ONE Reccado address to the
 * Worker serving this request. The web counterpart of `pnpm setup:routing
 * --address`, sharing its Cloudflare client and rule logic (`../email-routing`).
 *
 * Owner web session, or an MCP agent's `address_route` request once the owner
 * approved it on `/approve/:id` (src/lib/control-plane-kinds/address-route.ts runs
 * this same function; no MCP path reaches it without that approval).
 *
 * Authority is bounded the same way the DNS gate bounds DMARC writes:
 *   - the zone comes from the `domains` registry, never from the caller;
 *   - the address must be an active mailbox or alias in Reccado on that domain;
 *   - the only write is creating one literal `to:<address> -> <this Worker>` rule;
 *     nothing is updated or deleted, and the catch-all is never touched;
 *   - a rule or catch-all that already sends the address elsewhere is reported
 *     back, not overridden.
 *
 * Every refusal names its reason and a remedy a human can act on. Routing being
 * off for the zone is a refusal too: turning Email Routing on rewrites the
 * zone's MX records, which is not something a "Route it" click should do.
 */
import type { AuthContext } from "../../api/auth";
import { getAlias, getDomainByName, insertOpsEvent, listMailboxes } from "../../db/d1";
import {
	type ConflictingRule,
	createEmailRoutingApi,
	EmailRoutingApiError,
	ensureAddressRoute,
} from "../email-routing";
import { assertAdminAccess } from "./access";

const TIMEOUT_MS = 10_000;

/** The permission a token needs on the zone, as Cloudflare's token editor names it. */
export const ROUTING_TOKEN_PERMISSIONS =
	"Zone · Email Routing Rules · Edit and Zone · Zone Settings · Read";

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
			status: "created";
			address: string;
			worker: string;
			via: "rule";
			ruleId: string | null;
	  }
	| {
			ok: true;
			status: "already";
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
			/** The CLI fallback, when the refusal is about this Worker's access rather than the zone. */
			cli?: string;
			/** The rule in the way, for `conflict`. */
			conflict?: ConflictingRule;
	  };

/** HTTP status per refusal. 2xx is reserved for "the address is routed". */
export const REFUSAL_STATUS: Record<RouteRefusalReason, number> = {
	invalid_address: 400,
	domain_not_found: 404,
	domain_inactive: 422,
	address_unknown: 422,
	routing_disabled: 422,
	conflict: 409,
	token_missing: 424,
	worker_unknown: 424,
	permission: 424,
	timeout: 504,
	cloudflare_error: 502,
};

function cliFor(domain: string, address: string): string {
	return `pnpm setup:routing --domain ${domain} --address ${address} --env <env> --apply`;
}

export async function routeAddress(
	env: Env,
	actor: AuthContext,
	input: { domain: string; body: unknown },
): Promise<RouteAddressResult> {
	assertAdminAccess(env, actor, "");
	const domainName = input.domain.trim().toLowerCase();
	const rawAddress =
		typeof input.body === "object" && input.body !== null && "address" in input.body
			? (input.body as { address: unknown }).address
			: undefined;
	const address = typeof rawAddress === "string" ? rawAddress.trim().toLowerCase() : "";
	const refuse = (
		reason: RouteRefusalReason,
		message: string,
		remedy: string,
		extra: { cli?: string; conflict?: ConflictingRule } = {},
	): RouteAddressResult => ({ ok: false, reason, address, message, remedy, ...extra });

	if (!/^[^@\s]+@[^@\s]+$/.test(address) || !address.endsWith(`@${domainName}`)) {
		return refuse(
			"invalid_address",
			address
				? `${address} is not an address on ${domainName}.`
				: "The request did not name an address.",
			`Send { "address": "<name>@${domainName}" }.`,
		);
	}

	const domain = await getDomainByName(env.INDEX_DB, domainName);
	if (!domain)
		return refuse(
			"domain_not_found",
			`${domainName} is not registered in Reccado.`,
			"Add the domain in Settings > Domains first.",
		);
	if (domain.status !== "active")
		return refuse(
			"domain_inactive",
			`${domainName} is ${domain.status} in Reccado.`,
			`Turn ${domainName} back on in Settings > Domains, then route the address.`,
		);

	const mailboxes = await listMailboxes(env.INDEX_DB);
	const isMailbox = mailboxes.some(
		(m) => m.status === "active" && m.primary_address.toLowerCase() === address,
	);
	const alias = isMailbox ? null : await getAlias(env.INDEX_DB, address);
	if (!isMailbox && !(alias && alias.status === "active"))
		return refuse(
			"address_unknown",
			`${address} is not an active mailbox or alias in Reccado.`,
			"Create the mailbox (or alias) first. Reccado only routes addresses it files.",
		);

	const token = env.CLOUDFLARE_API_TOKEN?.trim();
	if (!token)
		return refuse(
			"token_missing",
			"CLOUDFLARE_API_TOKEN is not set on this Worker, so it can't change Email Routing.",
			`Set the CLOUDFLARE_API_TOKEN secret on this Worker to a token with ${ROUTING_TOKEN_PERMISSIONS} on ${domainName}, or run the command below where wrangler is logged in.`,
			{ cli: cliFor(domainName, address) },
		);
	const worker = env.WORKER_NAME?.trim();
	if (!worker)
		return refuse(
			"worker_unknown",
			"This Worker doesn't know its own name (WORKER_NAME is not set), so it can't say where the rule should deliver.",
			'Set the "WORKER_NAME" var to the Worker\'s "name" in wrangler.jsonc and redeploy, or run the command below.',
			{ cli: cliFor(domainName, address) },
		);

	const api = createEmailRoutingApi(token, { timeoutMs: TIMEOUT_MS });
	try {
		const outcome = await ensureAddressRoute(api, { zoneId: domain.zone_id, address, worker });
		switch (outcome.status) {
			case "routing_disabled":
				return refuse(
					"routing_disabled",
					`Email Routing is off for ${domainName}, so Cloudflare delivers no mail on it to any Worker.`,
					`Turn on Email Routing for ${domainName} (re-run Add domain with "Receive mail", or the Cloudflare dashboard: Email > Email Routing). Enabling it changes the zone's MX records, so Reccado doesn't do it from here.`,
				);
			case "conflict":
				return refuse(
					"conflict",
					outcome.rule.via === "catch_all"
						? `The catch-all on ${domainName} already sends mail for ${address} elsewhere (${outcome.rule.action}). Reccado won't override it.`
						: `A Cloudflare routing rule${outcome.rule.name ? ` ("${outcome.rule.name}")` : ""} already handles ${address}${outcome.rule.enabled ? "" : " (disabled)"}: ${outcome.rule.action}. Reccado won't change or delete it.`,
					outcome.rule.via === "catch_all"
						? `Add a rule for ${address} -> Worker ${worker} yourself in Cloudflare (Email > Email Routing > Routing rules), or point the catch-all at ${worker}.`
						: `Edit or delete that rule in Cloudflare (Email > Email Routing > Routing rules) so it delivers to Worker ${worker}, then retry.`,
					{ conflict: outcome.rule },
				);
			case "already":
				return {
					ok: true,
					status: "already",
					address,
					worker,
					via: outcome.via,
					ruleId: outcome.ruleId,
				};
			case "created":
				await insertOpsEvent(env.INDEX_DB, {
					id: crypto.randomUUID(),
					event_type: "admin.cloudflare_route_created",
					severity: "info",
					subject: address,
					payload_json: JSON.stringify({
						by: actor.email,
						domain: domainName,
						zone_id: domain.zone_id,
						address,
						worker,
						rule_id: outcome.ruleId,
						rule: outcome.rule,
					}),
				}).catch(() => undefined);
				return {
					ok: true,
					status: "created",
					address,
					worker,
					via: "rule",
					ruleId: outcome.ruleId,
				};
		}
	} catch (error) {
		if (error instanceof EmailRoutingApiError && error.reason === "permission")
			return refuse(
				"permission",
				`Cloudflare refused: the Worker's token may not manage Email Routing on ${domainName} (${error.message}).`,
				`Give CLOUDFLARE_API_TOKEN ${ROUTING_TOKEN_PERMISSIONS} on ${domainName}, or run the command below.`,
				{ cli: cliFor(domainName, address) },
			);
		const timeout = error instanceof EmailRoutingApiError && error.reason === "timeout";
		await insertOpsEvent(env.INDEX_DB, {
			id: crypto.randomUUID(),
			event_type: "admin.cloudflare_route_failed",
			severity: "warning",
			subject: address,
			payload_json: JSON.stringify({
				by: actor.email,
				domain: domainName,
				zone_id: domain.zone_id,
				address,
				worker,
				error: error instanceof Error ? error.message : String(error),
			}),
		}).catch(() => undefined);
		return refuse(
			timeout ? "timeout" : "cloudflare_error",
			timeout
				? "Cloudflare didn't answer in time, so it isn't known whether the rule was created."
				: `Cloudflare answered with an error: ${error instanceof Error ? error.message : String(error)}`,
			"Retry: it reads the zone first and never creates a second rule for the address. If it keeps failing, check Email Routing for the zone in the Cloudflare dashboard.",
		);
	}
}
