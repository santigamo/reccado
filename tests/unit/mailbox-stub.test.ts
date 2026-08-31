import { describe, expect, it } from "vitest";
import { type MailboxDoEnv, mailboxStub } from "#/lib/mailbox-stub";

// Node's `fs` is not the project filesystem inside the Workers pool, so the
// source tree is pulled in at build time instead: Vite resolves this glob and
// inlines every file under src/ as a string. Nothing is filtered — a bypass
// hidden in a .tsx route or in generated code is still a bypass.
const sourceFiles = import.meta.glob("../../src/**/*", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

// The deployed config, read the same way. Since an undeclared jurisdiction now
// throws on every request, a var dropped from here is a total outage rather than
// a quiet regression — which is the behaviour we want, but it is cheaper to
// catch before a deploy than after one.
import wranglerConfigRaw from "../../wrangler.jsonc?raw";

// The one file allowed to name the namespace directly. It has to be exempt
// rather than clever about it: on the `none` path it calls the raw `getByName`
// itself, which is the exact string this guard hunts for everywhere else.
const HELPER_PATH = "src/lib/mailbox-stub.ts";

// The three ways to reach a stub without a jurisdiction: `getByName` is the one
// the helper replaces, `get()` takes an id object and `idFromName()` mints that
// id — all of them derive from the plain namespace. Whitespace is permissive so
// a formatter-wrapped call cannot slip past.
const BYPASS_PATTERN = /MAILBOX_DO\s*\.\s*(?:getByName|idFromName|get)\s*\(/g;

const WHY_BYPASSING_HURTS = `A Durable Object id is derived from the namespace it is requested from, so
MAILBOX_DO.getByName(id) and MAILBOX_DO.jurisdiction("eu").getByName(id) are two
different objects for the same name. The non-jurisdictional one is brand new and
empty: nothing throws, nothing warns, the mailbox simply appears to have lost
every message it ever received — and the EU residency guarantee is gone with it.

Route the call sites listed above through mailboxStub(env, mailboxId) from
#/lib/mailbox-stub, the only file allowed to name the namespace directly.`;

/** `../../src/lib/x.ts` (or an absolute variant) -> `src/lib/x.ts`, for readable diffs. */
function toRepoPath(globKey: string): string {
	return globKey.slice(globKey.indexOf("src/"));
}

/** 1-based line of a match, so a failure points at somewhere you can open. */
function lineOf(source: string, index: number): number {
	return source.slice(0, index).split("\n").length;
}

function findBypasses(): string[] {
	// A Set because one line can hold two bypasses (`get(idFromName(...))`), and a
	// location repeated in the diff reads as a bug in this guard rather than in src.
	const offenders = new Set<string>();
	for (const [globKey, source] of Object.entries(sourceFiles)) {
		const path = toRepoPath(globKey);
		if (path === HELPER_PATH) continue;
		for (const match of source.matchAll(BYPASS_PATTERN)) {
			offenders.add(`${path}:${lineOf(source, match.index)}`);
		}
	}
	return [...offenders].sort();
}

describe("mailbox stub source guard", () => {
	// A guard that reads nothing passes forever. These assertions fail if the glob
	// ever stops resolving the real tree (test moved, layout changed), which is the
	// only way the check below could go quietly blind. The floor is far under the
	// current file count so it flags an empty glob, not ordinary deletions.
	it("actually reads the src tree", () => {
		const paths = Object.keys(sourceFiles).map(toRepoPath);
		expect(paths).toContain(HELPER_PATH);
		expect(paths.length).toBeGreaterThan(20);
		// Route components are .tsx and the router's file is generated; both are in
		// scope, so a bypass cannot hide by living outside src/lib.
		expect(paths.some((path) => path.endsWith(".tsx"))).toBe(true);
	});

	it("keeps the jurisdiction hop inside the helper", () => {
		const helperKey = Object.keys(sourceFiles).find((key) => toRepoPath(key) === HELPER_PATH);
		expect(helperKey).toBeDefined();
		expect(sourceFiles[helperKey as string]).toContain('.jurisdiction("eu")');
	});

	it("has no call site reaching MAILBOX_DO without going through mailboxStub", () => {
		expect(findBypasses(), WHY_BYPASSING_HURTS).toEqual([]);
	});
});

type FakeStub = { stubFor: string };

type FakeMailboxDo = {
	env: MailboxDoEnv;
	/** Jurisdictions asked for, in order. Empty means the plain namespace was used. */
	jurisdictions: string[];
	/** Ids the namespace resolved, tagged with the route taken to get there. */
	resolved: string[];
};

/**
 * Hand-rolled rather than a real namespace: `jurisdiction()` is unimplemented in
 * workerd, so the EU path cannot be exercised for real anywhere but a deployed
 * Worker. Tagging each returned stub with the route taken is what lets a test
 * tell "pinned to eu" apart from "silently resolved somewhere else" — the two
 * outcomes that look identical in production until the mail is missing.
 */
function createFakeEnv(jurisdiction?: string): FakeMailboxDo {
	const jurisdictions: string[] = [];
	const resolved: string[] = [];
	const namespace = {
		jurisdiction(name: string) {
			jurisdictions.push(name);
			return {
				getByName(id: string): FakeStub {
					resolved.push(`${name}:${id}`);
					return { stubFor: `${name}:${id}` };
				},
			};
		},
		getByName(id: string): FakeStub {
			resolved.push(`plain:${id}`);
			return { stubFor: `plain:${id}` };
		},
	};
	const env = {
		MAILBOX_DO: namespace,
		MAILBOX_JURISDICTION: jurisdiction,
	} as unknown as MailboxDoEnv;
	return { env, jurisdictions, resolved };
}

function stubOf(env: MailboxDoEnv, mailboxId: string): FakeStub {
	return mailboxStub(env, mailboxId) as unknown as FakeStub;
}

describe("mailboxStub", () => {
	it("pins to the eu jurisdiction when the environment declares eu", () => {
		const fake = createFakeEnv("eu");
		mailboxStub(fake.env, "mbx_abc");
		expect(fake.jurisdictions).toEqual(["eu"]);
		expect(fake.resolved).toEqual(["eu:mbx_abc"]);
	});

	it("passes the mailbox id through untouched", () => {
		// Nothing is normalized here on purpose: the id is already canonical by the
		// time it reaches this layer, and rewriting it would resolve a different DO.
		const fake = createFakeEnv("eu");
		mailboxStub(fake.env, "mbx_0123456789abcdefghijklmnop");
		expect(fake.resolved).toEqual(["eu:mbx_0123456789abcdefghijklmnop"]);
	});

	it("resolves the same id to the same stub", () => {
		const fake = createFakeEnv("eu");
		expect(stubOf(fake.env, "mbx_stable")).toEqual(stubOf(fake.env, "mbx_stable"));
		expect(fake.jurisdictions).toEqual(["eu", "eu"]);
	});

	it("resolves different ids to different stubs", () => {
		const fake = createFakeEnv("eu");
		expect(stubOf(fake.env, "mbx_a").stubFor).not.toBe(stubOf(fake.env, "mbx_b").stubFor);
	});

	it("skips the jurisdiction entirely when the environment declares none", () => {
		// The local-dev escape hatch: workerd implements no jurisdictions, so asking
		// for one would throw. There is no real mail here to keep in any country.
		const fake = createFakeEnv("none");
		mailboxStub(fake.env, "mbx_local");
		expect(fake.jurisdictions).toEqual([]);
		expect(fake.resolved).toEqual(["plain:mbx_local"]);
	});

	// Failing closed is the whole point: a deployed environment that lost its
	// declaration must not quietly serve an unpinned Durable Object. Each case
	// asserts the namespace was never touched, not merely that something threw —
	// and that the message names the variable, because that string is the only
	// thing standing between a misconfigured deploy and silently unpinned data.
	for (const [label, declared] of [
		["unset", undefined],
		["an empty string", ""],
		["some other region", "us"],
	] as const) {
		it(`refuses to resolve a mailbox when the jurisdiction is ${label}`, () => {
			const fake = createFakeEnv(declared);
			expect(() => mailboxStub(fake.env, "mbx_abc")).toThrow(/MAILBOX_JURISDICTION/);
			expect(fake.jurisdictions).toEqual([]);
			expect(fake.resolved).toEqual([]);
		});
	}

	it("says which value it got, so a bad deploy is diagnosable from the log line", () => {
		expect(() => mailboxStub(createFakeEnv(undefined).env, "mbx_abc")).toThrow(/unset/);
		expect(() => mailboxStub(createFakeEnv("us").env, "mbx_abc")).toThrow(/"us"/);
	});
});

describe("deployed jurisdiction declaration", () => {
	// `wrangler.jsonc` carries comments, so it is matched as text rather than
	// parsed. That is sufficient for what is being asserted: that the declaration
	// is present at all, and that nothing has quietly changed it to another region.
	it("declares eu for every environment that sets MAIL_FROM_ADDRESS", () => {
		const declarations = [
			...wranglerConfigRaw.matchAll(/"MAILBOX_JURISDICTION":\s*"([^"]*)"/g),
		].map((match) => match[1]);
		const mailFromCount = [...wranglerConfigRaw.matchAll(/"MAIL_FROM_ADDRESS":\s*"/g)].length;

		// Every `vars` block that configures sending is a deployable environment,
		// and each one needs its own declaration — inheritance across environments
		// is exactly the assumption that drops a var on the floor.
		expect(
			declarations.length,
			"every deployable environment in wrangler.jsonc must declare MAILBOX_JURISDICTION; " +
				"an environment missing it throws on its first request, because mailboxStub " +
				"refuses to resolve from an undeclared jurisdiction",
		).toBe(mailFromCount);

		expect(
			declarations.every((value) => value === "eu"),
			`deployed environments must declare "eu"; found ${JSON.stringify(declarations)}. ` +
				'"none" belongs in .dev.vars for local work, never in the committed config.',
		).toBe(true);
	});
});
