/**
 * The generated-config write behind `setup:sending` (and `pnpm onboard`), as a
 * pure function: which MAIL_FROM_ADDRESS / MAIL_SENDING_DOMAINS /
 * allowed_sender_addresses a run leaves in `wrangler.generated.<env>.json`.
 *
 * Factored out of `setup-sending.ts` so onboarding writes the file through the
 * same rules instead of a second copy of them. No fs here; callers read and
 * write the files.
 */
import {
	deployedVars,
	parseDomainList,
	type WranglerBlock,
	type WranglerConfig,
} from "./deploy-config";

export type SendingConfigUpdate = {
	/** The whole config to write to the generated path. A new object; inputs are untouched. */
	config: WranglerConfig;
	/** The block inside `config` for the env (the one the vars were written to). */
	block: WranglerBlock;
	previousFrom: string | undefined;
	nextFrom: string;
	/** True when an existing default sender was kept instead of `fromAddress`. */
	fromAddressPreserved: boolean;
	/** MAIL_SENDING_DOMAINS as a deploy would ship it before this update. */
	previousSendingDomains: string[];
	/** MAIL_SENDING_DOMAINS after this update: sorted union. */
	sendingDomains: string[];
	/** The EMAIL send_email binding's allow-list shape. */
	emailBinding: "absent" | "unbounded" | "bounded";
	/** The allow-list after this update, when bounded (or narrowed by restrictSenders). */
	allowedSenders?: string[];
	/** Whether writing `config` would change the generated file (or create it). */
	changed: boolean;
};

export type SendingConfigResult =
	| { ok: true; value: SendingConfigUpdate }
	| { ok: false; error: string; source: "generated" | "tracked" };

/**
 * Adding a sending domain must not reconfigure the ones already there.
 *
 *   MAIL_FROM_ADDRESS is a single value: the fallback identity for every mailbox
 *   whose own domain is not verified. It is only set when there is none yet, or
 *   when `setDefaultFrom` asks for it by name.
 *
 *   allowed_sender_addresses is ABSENT by default, and absent means "any sender".
 *   Adding one address does not widen an existing list, it replaces an unbounded
 *   permission with a list of exactly one — so an unbounded list stays unbounded
 *   unless `restrictSenders` asks for it by name. A list that is already bounded
 *   is widened with `addSenders`.
 *
 *   MAIL_SENDING_DOMAINS is a union and never a replacement.
 *
 * Reads the current values from what a deploy of this env WILL ship (tracked vars
 * with the generated overlay applied), so a value declared only in wrangler.jsonc
 * survives the write.
 */
export function planSendingConfigUpdate(opts: {
	tracked: WranglerConfig;
	/** The parsed generated file, or undefined when it does not exist yet. */
	generated: WranglerConfig | undefined;
	env: string | undefined;
	addDomains: string[];
	fromAddress: string;
	addSenders: string[];
	setDefaultFrom?: boolean;
	restrictSenders?: boolean;
}): SendingConfigResult {
	const source = opts.generated ?? opts.tracked;
	const config = structuredClone(source) as WranglerConfig;
	const block: WranglerBlock | undefined = opts.env ? config.env?.[opts.env] : config;
	if (!block) {
		return {
			ok: false,
			error: `no config block for env "${opts.env ?? "production"}"`,
			source: opts.generated ? "generated" : "tracked",
		};
	}

	const currentVars = deployedVars(opts.tracked, opts.generated, opts.env);
	const previousFrom =
		typeof currentVars.MAIL_FROM_ADDRESS === "string" ? currentVars.MAIL_FROM_ADDRESS : undefined;
	const nextFrom = previousFrom && !opts.setDefaultFrom ? previousFrom : opts.fromAddress;

	const previousSendingDomains = parseDomainList(currentVars.MAIL_SENDING_DOMAINS);
	const union = new Set(previousSendingDomains);
	for (const domain of opts.addDomains) union.add(domain.trim().toLowerCase());
	const sendingDomains = [...union].sort();

	block.vars = {
		...(block.vars ?? {}),
		MAIL_FROM_ADDRESS: nextFrom,
		MAIL_SENDING_DOMAINS: sendingDomains.join(","),
	};

	const binding =
		block.send_email?.find((entry) => entry.name === "EMAIL") ?? block.send_email?.[0];
	const unbounded = binding ? binding.allowed_sender_addresses === undefined : false;
	let allowedSenders: string[] | undefined;
	if (binding && (!unbounded || opts.restrictSenders)) {
		const next = new Set(binding.allowed_sender_addresses ?? []);
		for (const sender of opts.addSenders) next.add(sender);
		binding.allowed_sender_addresses = [...next].sort();
		allowedSenders = binding.allowed_sender_addresses;
	}

	return {
		ok: true,
		value: {
			config,
			block,
			previousFrom,
			nextFrom,
			fromAddressPreserved: nextFrom !== opts.fromAddress,
			previousSendingDomains,
			sendingDomains,
			emailBinding: !binding ? "absent" : unbounded ? "unbounded" : "bounded",
			allowedSenders,
			changed: !opts.generated || JSON.stringify(opts.generated) !== JSON.stringify(config),
		},
	};
}
