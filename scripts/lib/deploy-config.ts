/**
 * What a deploy actually ships, as data.
 *
 * Two files describe a deployment. The tracked `wrangler.jsonc` owns the
 * STRUCTURE: bindings, queues, Durable Objects, migrations, compat flags — the
 * things the code in this commit depends on, which is why they must travel
 * with the code. The gitignored `wrangler.generated.<env>.json` owns the
 * OPERATOR FACTS the setup scripts discover or decide for one account: the
 * real D1 id, the custom-domain route, the verified sending domains, the
 * sender allow-list. Those are personal and do not belong in a public repo.
 *
 * Until this module existed the two were joined in two different ways. The
 * setup scripts copied the generated file over the build wholesale — structure
 * included, from a snapshot taken whenever the file was first rendered, so a
 * queue added to wrangler.jsonc after that snapshot would silently vanish from
 * the deploy. And `pnpm run deploy:dev` ignored the generated file entirely, so
 * a sending domain `setup:sending` had written there never reached the Worker.
 * Both were silent.
 *
 * The rule now, in one place and for every deploy path:
 *
 *   The generated file WINS, but only for the fields it owns (listed below).
 *   Everything else comes from the tracked config, and every structural field
 *   where the generated file disagrees is reported as ignored, not applied.
 *
 * Pure: no fs, no subprocess. The IO wrapper lives in `built-config.ts`.
 */

export type RouteEntry = { pattern: string; custom_domain?: boolean; [k: string]: unknown };

export type WranglerBlock = {
	name?: string;
	vars?: Record<string, unknown>;
	workers_dev?: boolean;
	routes?: RouteEntry[];
	send_email?: Array<{ name?: string; allowed_sender_addresses?: string[]; [k: string]: unknown }>;
	d1_databases?: Array<{
		binding: string;
		database_name?: string;
		database_id?: string;
		migrations_dir?: string;
		[k: string]: unknown;
	}>;
	queues?: {
		producers?: Array<{ binding: string; queue: string }>;
		consumers?: Array<{ queue: string; dead_letter_queue?: string }>;
	};
	[k: string]: unknown;
};

export type WranglerConfig = WranglerBlock & { env?: Record<string, WranglerBlock> };

/** Fields the generated file is allowed to set. Human-readable, for reports and docs. */
export const GENERATED_OWNED_FIELDS = [
	"vars.* (per variable; variables only in wrangler.jsonc are kept)",
	"d1_databases[].database_id (per binding already declared in wrangler.jsonc)",
	"send_email[].allowed_sender_addresses (per binding already declared in wrangler.jsonc)",
	"routes + workers_dev (together, only when the generated file declares routes — setup:domain)",
] as const;

/**
 * Keys a stale snapshot most plausibly disagrees on. Compared only to report
 * them as ignored; the tracked value is what deploys.
 */
const STRUCTURAL_KEYS = [
	"name",
	"main",
	"triggers",
	"durable_objects",
	"r2_buckets",
	"queues",
	"migrations",
	"compatibility_date",
	"compatibility_flags",
	"observability",
	"upload_source_maps",
] as const;

export function stripJsonc(input: string): string {
	return input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Keys wrangler does NOT inherit from the top level into a named env. Letting
 * them fall through would, for instance, overlay the production block's vars
 * onto a dev deploy whose generated env block happens to omit `vars`.
 */
const NON_INHERITABLE_KEYS = new Set([
	"vars",
	"d1_databases",
	"send_email",
	"queues",
	"durable_objects",
	"r2_buckets",
	"kv_namespaces",
	"services",
]);

/**
 * The block wrangler would use for `env` (undefined = top-level): the env
 * block, with inheritable top-level keys filling what it leaves out.
 */
export function effectiveBlock(config: WranglerConfig, env: string | undefined): WranglerBlock {
	const { env: envs, ...top } = config;
	if (!env) return top;
	const envBlock = envs?.[env];
	if (!envBlock) throw new Error(`no config block for env "${env}"`);
	const merged: WranglerBlock = {};
	for (const [key, value] of Object.entries(top)) {
		if (!NON_INHERITABLE_KEYS.has(key)) merged[key] = value;
	}
	for (const [key, value] of Object.entries(envBlock)) {
		if (value !== undefined) merged[key] = value;
	}
	return merged;
}

export type OverlayChange = { field: string; from: unknown; to: unknown };

export type OverlayResult = {
	/** The config that will be deployed. A new object; inputs are not mutated. */
	config: WranglerBlock;
	/** Generated-owned fields whose value differs from the base and was applied. */
	applied: OverlayChange[];
	/** Fields the generated file disagrees on but does not own; the base value was kept. */
	ignored: string[];
};

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Applies the generated-owned fields of `generated` onto `base`.
 *
 * `base` is what would deploy without the generated file: the built
 * `dist/server/wrangler.json` at deploy time, or the tracked block when a
 * caller (doctor, setup:sending) wants to know what a deploy WILL ship.
 * `tracked` is the tracked effective block, used only to decide which
 * structural disagreements to report — comparing against the build instead
 * would flag every path the Vite plugin normalises.
 */
export function applyGeneratedOverlay(opts: {
	base: WranglerBlock;
	generated: WranglerBlock;
	tracked?: WranglerBlock;
}): OverlayResult {
	const { generated } = opts;
	const config: WranglerBlock = structuredClone(opts.base);
	const applied: OverlayChange[] = [];
	const ignored: string[] = [];

	if (generated.vars) {
		const vars: Record<string, unknown> = { ...(config.vars ?? {}) };
		for (const [name, value] of Object.entries(generated.vars)) {
			if (value === undefined) continue;
			if (!same(vars[name], value)) {
				applied.push({ field: `vars.${name}`, from: vars[name], to: value });
				vars[name] = value;
			}
		}
		config.vars = vars;
	}

	for (const db of generated.d1_databases ?? []) {
		if (!db.database_id) continue;
		const target = config.d1_databases?.find((entry) => entry.binding === db.binding);
		if (!target) {
			ignored.push(`d1_databases[${db.binding}] (not declared in wrangler.jsonc)`);
			continue;
		}
		if (target.database_id !== db.database_id) {
			applied.push({
				field: `d1_databases[${db.binding}].database_id`,
				from: target.database_id,
				to: db.database_id,
			});
			target.database_id = db.database_id;
		}
	}

	for (const binding of generated.send_email ?? []) {
		if (binding.allowed_sender_addresses === undefined) continue;
		const target = config.send_email?.find((entry) => entry.name === binding.name);
		if (!target) {
			ignored.push(`send_email[${binding.name ?? "?"}] (not declared in wrangler.jsonc)`);
			continue;
		}
		if (!same(target.allowed_sender_addresses, binding.allowed_sender_addresses)) {
			applied.push({
				field: `send_email[${binding.name ?? "?"}].allowed_sender_addresses`,
				from: target.allowed_sender_addresses,
				to: binding.allowed_sender_addresses,
			});
			target.allowed_sender_addresses = [...binding.allowed_sender_addresses];
		}
	}

	// routes and workers_dev travel as a pair because setup:domain writes them as
	// one decision ("serve on this hostname, close workers.dev"). Without routes a
	// generated workers_dev is almost certainly a snapshot of an older tracked
	// value, and applying it would quietly reopen workers.dev.
	if (generated.routes && generated.routes.length > 0) {
		if (!same(config.routes, generated.routes)) {
			applied.push({ field: "routes", from: config.routes, to: generated.routes });
			config.routes = structuredClone(generated.routes);
		}
		const workersDev = generated.workers_dev ?? false;
		if (config.workers_dev !== workersDev) {
			applied.push({ field: "workers_dev", from: config.workers_dev, to: workersDev });
			config.workers_dev = workersDev;
		}
	} else if (
		generated.workers_dev !== undefined &&
		opts.tracked &&
		generated.workers_dev !== opts.tracked.workers_dev
	) {
		ignored.push("workers_dev (no routes in the generated file, so it is not setup:domain's)");
	}

	if (opts.tracked) {
		for (const key of STRUCTURAL_KEYS) {
			const value = generated[key];
			if (value !== undefined && !same(value, opts.tracked[key])) ignored.push(key);
		}
	}

	return { config, applied, ignored };
}

/**
 * Every generated-owned value that the final config does NOT carry. Empty means
 * the deploy ships exactly what the generated file says. Run on the file as
 * re-read from disk, so it checks what wrangler will read, not what we meant.
 */
export function findOverlayMismatches(final: WranglerBlock, generated: WranglerBlock): string[] {
	const out: string[] = [];
	for (const [name, value] of Object.entries(generated.vars ?? {})) {
		if (value === undefined) continue;
		if (!same(final.vars?.[name], value)) {
			out.push(
				`vars.${name}: generated=${JSON.stringify(value)} deployed=${JSON.stringify(final.vars?.[name])}`,
			);
		}
	}
	for (const db of generated.d1_databases ?? []) {
		if (!db.database_id) continue;
		const target = final.d1_databases?.find((entry) => entry.binding === db.binding);
		if (target && target.database_id !== db.database_id) {
			out.push(
				`d1_databases[${db.binding}].database_id: generated=${db.database_id} deployed=${target.database_id}`,
			);
		}
	}
	for (const binding of generated.send_email ?? []) {
		if (binding.allowed_sender_addresses === undefined) continue;
		const target = final.send_email?.find((entry) => entry.name === binding.name);
		if (target && !same(target.allowed_sender_addresses, binding.allowed_sender_addresses)) {
			out.push(`send_email[${binding.name ?? "?"}].allowed_sender_addresses differ`);
		}
	}
	if (generated.routes && generated.routes.length > 0 && !same(final.routes, generated.routes)) {
		out.push("routes differ");
	}
	return out;
}

/**
 * The vars a deploy of `env` will ship: tracked vars with the generated file's
 * applied on top. Callers that reason about "the deployed config" (doctor,
 * setup:sending's union) use this so they agree with the deploy path.
 */
export function deployedVars(
	tracked: WranglerConfig,
	generated: WranglerConfig | undefined,
	env: string | undefined,
): Record<string, unknown> {
	const trackedBlock = effectiveBlock(tracked, env);
	if (!generated) return { ...(trackedBlock.vars ?? {}) };
	const generatedBlock = effectiveBlock(generated, env);
	return applyGeneratedOverlay({ base: trackedBlock, generated: generatedBlock }).config.vars ?? {};
}

/** Comma-separated domain list, lowercased and de-duplicated, as the Worker parses it. */
export function parseDomainList(raw: unknown): string[] {
	if (typeof raw !== "string") return [];
	return [
		...new Set(
			raw
				.split(",")
				.map((entry) => entry.trim().toLowerCase())
				.filter(Boolean),
		),
	];
}
