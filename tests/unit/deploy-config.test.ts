import { describe, expect, it } from "vitest";
import {
	applyGeneratedOverlay,
	deployedVars,
	effectiveBlock,
	findOverlayMismatches,
	parseDomainList,
	type WranglerBlock,
	type WranglerConfig,
} from "../../scripts/lib/deploy-config";

const QUEUES_NOW = {
	producers: [
		{ binding: "INBOUND_EMAIL_QUEUE", queue: "inbound-dev" },
		{ binding: "EMAIL_EVENTS_QUEUE", queue: "events-dev" },
		{ binding: "NOTIFY_QUEUE", queue: "notify-dev" },
	],
};
// What a generated file rendered months ago carries: one queue.
const QUEUES_THEN = { producers: [{ binding: "INBOUND_EMAIL_QUEUE", queue: "inbound-dev" }] };

function built(overrides: Partial<WranglerBlock> = {}): WranglerBlock {
	return {
		name: "reccado-dev",
		workers_dev: false,
		vars: { MAIL_FROM_ADDRESS: "noreply@send.example.com", MAILBOX_JURISDICTION: "eu" },
		send_email: [{ name: "EMAIL" }],
		d1_databases: [
			{
				binding: "INDEX_DB",
				database_name: "index-dev",
				database_id: "00000000-0000-0000-0000-000000000000",
				migrations_dir: "../../migrations/d1",
			},
		],
		queues: QUEUES_NOW,
		...overrides,
	};
}

describe("applyGeneratedOverlay", () => {
	// The incident: setup:sending wrote the var into the generated file and the
	// deploy never read it. With the overlay it ships.
	it("ships a var that only the generated file declares", () => {
		const result = applyGeneratedOverlay({
			base: built(),
			generated: { vars: { MAIL_SENDING_DOMAINS: "example.com,send.example.com" } },
		});
		expect(result.config.vars?.MAIL_SENDING_DOMAINS).toBe("example.com,send.example.com");
		expect(result.config.vars?.MAILBOX_JURISDICTION).toBe("eu");
		expect(result.applied).toEqual([
			{
				field: "vars.MAIL_SENDING_DOMAINS",
				from: undefined,
				to: "example.com,send.example.com",
			},
		]);
	});

	it("lets the generated value win over a different tracked value, and says so", () => {
		const result = applyGeneratedOverlay({
			base: built({ vars: { MAIL_SENDING_DOMAINS: "send.example.com" } }),
			generated: { vars: { MAIL_SENDING_DOMAINS: "example.com,send.example.com" } },
		});
		expect(result.config.vars?.MAIL_SENDING_DOMAINS).toBe("example.com,send.example.com");
		expect(result.applied[0]).toMatchObject({ from: "send.example.com" });
	});

	it("changes nothing when both files agree (today's live dev values)", () => {
		const vars = { MAIL_SENDING_DOMAINS: "send.transcribo.es,transcribo.es" };
		const base = built({ vars: { ...built().vars, ...vars } });
		const result = applyGeneratedOverlay({ base, generated: { vars } });
		expect(result.applied).toEqual([]);
		expect(result.config).toEqual(base);
	});

	// The opposite failure the old setup:domain/setup:cloud patch had: copying a
	// stale snapshot wholesale would drop queues added to wrangler.jsonc since.
	it("never applies structural fields from a stale snapshot, and reports them", () => {
		const tracked = built();
		const result = applyGeneratedOverlay({
			base: built(),
			generated: { queues: QUEUES_THEN, workers_dev: true },
			tracked,
		});
		expect(result.config.queues).toEqual(QUEUES_NOW);
		expect(result.config.workers_dev).toBe(false);
		expect(result.ignored).toContain("queues");
		expect(result.ignored.some((field) => field.startsWith("workers_dev"))).toBe(true);
	});

	it("applies routes and workers_dev together when setup:domain wrote them", () => {
		const result = applyGeneratedOverlay({
			base: built({ workers_dev: true }),
			generated: {
				routes: [{ pattern: "inbox.example.com", custom_domain: true }],
				workers_dev: false,
			},
		});
		expect(result.config.routes).toEqual([{ pattern: "inbox.example.com", custom_domain: true }]);
		expect(result.config.workers_dev).toBe(false);
	});

	it("applies the real D1 id but keeps the build's migrations_dir", () => {
		const result = applyGeneratedOverlay({
			base: built(),
			generated: {
				d1_databases: [
					{ binding: "INDEX_DB", database_id: "real-id", migrations_dir: "migrations/d1" },
				],
			},
		});
		expect(result.config.d1_databases?.[0]).toMatchObject({
			database_id: "real-id",
			migrations_dir: "../../migrations/d1",
		});
	});

	it("ignores a D1 binding wrangler.jsonc does not declare", () => {
		const result = applyGeneratedOverlay({
			base: built(),
			generated: { d1_databases: [{ binding: "OTHER_DB", database_id: "x" }] },
		});
		expect(result.config.d1_databases).toHaveLength(1);
		expect(result.ignored[0]).toMatch(/OTHER_DB/);
	});

	it("applies an explicit sender allow-list", () => {
		const result = applyGeneratedOverlay({
			base: built(),
			generated: {
				send_email: [{ name: "EMAIL", allowed_sender_addresses: ["hello@send.example.com"] }],
			},
		});
		expect(result.config.send_email?.[0]?.allowed_sender_addresses).toEqual([
			"hello@send.example.com",
		]);
	});

	it("does not mutate its inputs", () => {
		const base = built();
		const snapshot = structuredClone(base);
		applyGeneratedOverlay({ base, generated: { vars: { NEW: "1" } } });
		expect(base).toEqual(snapshot);
	});
});

describe("findOverlayMismatches", () => {
	it("is empty for an overlaid config", () => {
		const generated: WranglerBlock = { vars: { MAIL_SENDING_DOMAINS: "a.example.com" } };
		const { config } = applyGeneratedOverlay({ base: built(), generated });
		expect(findOverlayMismatches(config, generated)).toEqual([]);
	});

	// The guard: a deploy file that does not carry the generated value must be
	// caught before wrangler runs, not discovered in production.
	it("names every generated value the deploy file would not ship", () => {
		const generated: WranglerBlock = { vars: { MAIL_SENDING_DOMAINS: "a.example.com" } };
		expect(findOverlayMismatches(built(), generated)).toEqual([
			'vars.MAIL_SENDING_DOMAINS: generated="a.example.com" deployed=undefined',
		]);
	});
});

describe("effectiveBlock", () => {
	const config: WranglerConfig = {
		name: "reccado",
		compatibility_date: "2026-01-01",
		vars: { MAIL_FROM_ADDRESS: "prod@example.com" },
		env: { dev: { name: "reccado-dev" } },
	};

	it("inherits inheritable top-level keys into an env", () => {
		expect(effectiveBlock(config, "dev").compatibility_date).toBe("2026-01-01");
		expect(effectiveBlock(config, "dev").name).toBe("reccado-dev");
	});

	// wrangler does not inherit vars; letting them fall through would overlay the
	// production sender onto a dev deploy.
	it("does not inherit vars into an env", () => {
		expect(effectiveBlock(config, "dev").vars).toBeUndefined();
	});

	it("throws on an unknown env", () => {
		expect(() => effectiveBlock(config, "staging")).toThrow(/staging/);
	});
});

describe("deployedVars", () => {
	const tracked: WranglerConfig = {
		env: { dev: { vars: { MAIL_FROM_ADDRESS: "noreply@send.example.com", ONLY_TRACKED: "1" } } },
	};

	it("is the tracked vars when there is no generated file", () => {
		expect(deployedVars(tracked, undefined, "dev")).toEqual({
			MAIL_FROM_ADDRESS: "noreply@send.example.com",
			ONLY_TRACKED: "1",
		});
	});

	it("is tracked with generated on top, keeping tracked-only vars", () => {
		const generated: WranglerConfig = {
			env: { dev: { vars: { MAIL_SENDING_DOMAINS: "send.example.com" } } },
		};
		expect(deployedVars(tracked, generated, "dev")).toEqual({
			MAIL_FROM_ADDRESS: "noreply@send.example.com",
			ONLY_TRACKED: "1",
			MAIL_SENDING_DOMAINS: "send.example.com",
		});
	});
});

describe("parseDomainList", () => {
	it("lowercases, trims and de-duplicates", () => {
		expect(parseDomainList(" Send.Example.com, ,example.com,send.example.com")).toEqual([
			"send.example.com",
			"example.com",
		]);
	});

	it("is empty for anything but a string", () => {
		expect(parseDomainList(undefined)).toEqual([]);
		expect(parseDomainList(42)).toEqual([]);
	});
});
