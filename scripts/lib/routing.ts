/**
 * Cloudflare Email Routing, as data: the argv that creates a literal
 * `to:<address> -> worker` rule, and parsers for the two read commands whose
 * plain-text output is the only surface wrangler offers (neither has `--json`).
 *
 * Pure (no node:*), shared by `setup:routing` (which creates rules) and
 * `pnpm onboard` (which first reads what exists, so it only creates what is
 * missing and never overwrites a rule it did not make).
 */

/** `wrangler email routing rules create` argv for a literal `to` match delivered to a Worker. */
export function literalRoutingRuleArgs(opts: {
	zone: string;
	address: string;
	worker: string;
	/** Optional rule name. `setup:routing` has never set one; `onboard` does. */
	name?: string;
}): string[] {
	return [
		"email",
		"routing",
		"rules",
		"create",
		opts.zone,
		...(opts.name ? ["--name", opts.name] : []),
		"--match-type",
		"literal",
		"--match-field",
		"to",
		"--match-value",
		opts.address,
		"--action-type",
		"worker",
		"--action-value",
		opts.worker,
	];
}

export type RoutingMatcher = { field: string; value: string } | { type: string };
export type RoutingAction = { type: string; values: string[] };

export type RoutingRule = {
	id: string;
	name: string;
	enabled: boolean;
	matchers: RoutingMatcher[];
	actions: RoutingAction[];
	priority: number | null;
};

export type RoutingRulesListing = {
	rules: RoutingRule[];
	/** The catch-all line, when present. Reported, never acted on. */
	catchAll: { enabled: boolean; action: string } | null;
};

/**
 * Parses `wrangler email routing rules list <zone>`:
 *
 *   Rule: 234290dc4c61417aaee662d86d42956a
 *     Name:     soporte -> reccado
 *     Enabled:  true
 *     Matchers: to:soporte@example.com
 *     Actions:  worker:reccado-dev
 *     Priority: 0
 *
 *   Catch-all rule: disabled, action: drop
 *
 * Matchers print as `field:value` (literal) or the bare type (`all`), joined by
 * ", "; actions as `type:v1,v2` or the bare type. Blocks missing an id are
 * skipped rather than guessed at.
 */
export function parseRoutingRulesList(output: string): RoutingRulesListing {
	const rules: RoutingRule[] = [];
	let current: RoutingRule | null = null;
	let catchAll: RoutingRulesListing["catchAll"] = null;
	const flush = () => {
		if (current?.id) rules.push(current);
		current = null;
	};
	for (const line of output.split(/\r?\n/)) {
		const ruleHeader = line.match(/^Rule:\s*(\S+)\s*$/);
		if (ruleHeader?.[1]) {
			flush();
			current = {
				id: ruleHeader[1],
				name: "",
				enabled: false,
				matchers: [],
				actions: [],
				priority: null,
			};
			continue;
		}
		const catchAllLine = line.match(/^Catch-all rule:\s*(enabled|disabled),\s*action:\s*(.*)$/i);
		if (catchAllLine) {
			flush();
			catchAll = {
				enabled: catchAllLine[1]?.toLowerCase() === "enabled",
				action: (catchAllLine[2] ?? "").trim(),
			};
			continue;
		}
		if (!current) continue;
		const rule: RoutingRule = current;
		const field = line.match(/^\s{2,}(Name|Enabled|Matchers|Actions|Priority):\s*(.*)$/);
		if (!field?.[1]) continue;
		const value = (field[2] ?? "").trim();
		switch (field[1]) {
			case "Name":
				rule.name = value === "(none)" ? "" : value;
				break;
			case "Enabled":
				rule.enabled = value.toLowerCase() === "true";
				break;
			case "Matchers":
				rule.matchers = splitList(value).map((entry) => {
					const colon = entry.indexOf(":");
					return colon === -1
						? { type: entry }
						: { field: entry.slice(0, colon), value: entry.slice(colon + 1) };
				});
				break;
			case "Actions":
				rule.actions = splitList(value).map((entry) => {
					const colon = entry.indexOf(":");
					return colon === -1
						? { type: entry, values: [] }
						: {
								type: entry.slice(0, colon),
								values: entry
									.slice(colon + 1)
									.split(",")
									.map((v) => v.trim())
									.filter(Boolean),
							};
				});
				break;
			case "Priority": {
				const n = Number.parseInt(value, 10);
				rule.priority = Number.isNaN(n) ? null : n;
				break;
			}
		}
	}
	flush();
	return { rules, catchAll };
}

/**
 * Splits on ", " between entries. Action values are themselves comma-joined
 * without a space (`worker:a,b`), so only a comma followed by whitespace
 * separates entries.
 */
function splitList(value: string): string[] {
	return value
		.split(/,\s+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export type RoutingSettings = { enabled: boolean; status: string | null };

/**
 * Parses `wrangler email routing settings <zone>`:
 *
 *   Email Routing for example.com:
 *     Enabled:  true
 *     Status:   ready
 *
 * Null when the output does not carry an Enabled line at all.
 */
export function parseRoutingSettings(output: string): RoutingSettings | null {
	const enabled = output.match(/^\s+Enabled:\s*(\S+)/m)?.[1];
	if (enabled === undefined) return null;
	const status = output.match(/^\s+Status:\s*(\S+)/m)?.[1] ?? null;
	return { enabled: enabled.toLowerCase() === "true", status: status?.toLowerCase() ?? null };
}

/** Whether any of a rule's matchers is `to:<address>` (case-insensitive). */
export function ruleMatchesAddress(rule: RoutingRule, address: string): boolean {
	const wanted = address.trim().toLowerCase();
	return rule.matchers.some(
		(matcher) =>
			"field" in matcher &&
			matcher.field.toLowerCase() === "to" &&
			matcher.value.trim().toLowerCase() === wanted,
	);
}

/** Whether a rule delivers to exactly this Worker and nothing else. */
export function ruleDeliversToWorker(rule: RoutingRule, worker: string): boolean {
	return (
		rule.actions.length === 1 &&
		rule.actions[0]?.type === "worker" &&
		rule.actions[0].values.length === 1 &&
		rule.actions[0].values[0] === worker
	);
}
