import { describe, expect, it } from "vitest";
import {
	compareTopicRegistry,
	looksLikeMailboxTopic,
	parseTopicRegistry,
	type RegistryTopic,
	type TopicMapping,
} from "../../scripts/lib/telegram-topic-registry";

const HQ = "-1004344536018";
const PRIVATE = "1955044240";

const REGISTRY_JSON = JSON.stringify({
	"citta-ops": { id: 6, name: "Citta ops" },
	"correo-eccos": { id: 30, name: "Correo · Eccos" },
	"correo-imsanti": { id: 31, name: "Correo · imsanti" },
	"correo-transcribo": { id: 32, name: "Correo · Transcribo" },
	licitaciones: { id: 5, name: "Licitaciones" },
});

function registry(): RegistryTopic[] {
	const parsed = parseTopicRegistry(REGISTRY_JSON);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.topics;
}

const MAPPINGS: TopicMapping[] = [
	{ chatId: HQ, mailboxId: "mbx_e", address: "notify@eccos.chat", topicId: 30 },
	{ chatId: HQ, mailboxId: "mbx_i", address: "hello@imsanti.dev", topicId: 31 },
	{ chatId: HQ, mailboxId: "mbx_t", address: "soporte@transcribo.es", topicId: 32 },
];

describe("parseTopicRegistry", () => {
	it("reads tg-hq's slug -> { id, name } shape, sorted by slug", () => {
		const topics = registry();
		expect(topics.map((t) => t.slug)).toEqual([
			"citta-ops",
			"correo-eccos",
			"correo-imsanti",
			"correo-transcribo",
			"licitaciones",
		]);
		expect(topics[2]).toEqual({ slug: "correo-imsanti", id: 31, name: "Correo · imsanti" });
	});

	it("treats empty text as an empty registry", () => {
		expect(parseTopicRegistry("  ")).toEqual({ ok: true, topics: [] });
	});

	it("rejects malformed registries the way tg-hq does", () => {
		expect(parseTopicRegistry("{nope").ok).toBe(false);
		expect(parseTopicRegistry("[]").ok).toBe(false);
		expect(parseTopicRegistry('{"a": {"id": "7", "name": "A"}}').ok).toBe(false);
		expect(parseTopicRegistry('{"a": {"id": 7.5, "name": "A"}}').ok).toBe(false);
		expect(parseTopicRegistry('{"a": {"id": 7, "name": " "}}').ok).toBe(false);
		expect(parseTopicRegistry('{"a": 7}').ok).toBe(false);
	});
});

describe("looksLikeMailboxTopic", () => {
	it("recognises mailbox topics by slug prefix or name", () => {
		expect(looksLikeMailboxTopic({ slug: "correo-eccos", id: 1, name: "x" })).toBe(true);
		expect(looksLikeMailboxTopic({ slug: "soporte", id: 1, name: "Correo · soporte" })).toBe(true);
		expect(looksLikeMailboxTopic({ slug: "inbox-acme", id: 1, name: "Acme" })).toBe(true);
		expect(looksLikeMailboxTopic({ slug: "citta-ops", id: 6, name: "Citta ops" })).toBe(false);
		expect(looksLikeMailboxTopic({ slug: "mailer", id: 1, name: "Mailer stats" })).toBe(false);
	});
});

describe("compareTopicRegistry", () => {
	it("passes every mapping whose thread id the registry records", () => {
		const findings = compareTopicRegistry({
			boundChatId: HQ,
			registryChatId: HQ,
			registry: registry(),
			mappings: MAPPINGS,
		});
		expect(findings.map((f) => f.status)).toEqual(["pass", "pass", "pass"]);
		expect(findings[1]?.message).toContain("hello@imsanti.dev -> thread 31");
		expect(findings[1]?.message).toContain('"correo-imsanti"');
	});

	it("reports a single info line when the bound chat is not the HQ forum", () => {
		const findings = compareTopicRegistry({
			boundChatId: PRIVATE,
			registryChatId: HQ,
			registry: registry(),
			mappings: [
				...MAPPINGS,
				{ chatId: PRIVATE, mailboxId: "mbx_i", address: "hello@imsanti.dev", topicId: 999 },
			],
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]?.status).toBe("info");
		expect(findings[0]?.message).toContain(`Bound chat is ${PRIVATE}`);
		expect(findings[0]?.message).toContain("3 D1 topic mapping(s) for the HQ forum exist");
		expect(findings[0]?.message).toContain("unused until a rebind");
	});

	it("says so when nothing is bound and no HQ rows are staged", () => {
		const [finding] = compareTopicRegistry({
			boundChatId: null,
			registryChatId: HQ,
			registry: registry(),
			mappings: [],
		});
		expect(finding?.status).toBe("info");
		expect(finding?.message).toContain("No chat is bound");
		expect(finding?.message).toContain("no D1 topic mappings exist for the HQ forum yet");
	});

	it("flags a thread id mismatch against the entry named for the mailbox", () => {
		const findings = compareTopicRegistry({
			boundChatId: HQ,
			registryChatId: HQ,
			registry: registry(),
			mappings: [MAPPINGS[0], { ...MAPPINGS[1], topicId: 44 }, MAPPINGS[2]] as TopicMapping[],
		});
		const mismatch = findings.find((f) => f.message.includes("hello@imsanti.dev"));
		expect(mismatch?.status).toBe("warn");
		expect(mismatch?.message).toContain("thread id mismatch");
		expect(mismatch?.message).toContain("D1 delivers to thread 44");
		expect(mismatch?.message).toContain("records thread 31");
		// The registry's thread 31 now receives nothing, so it is also reported, once, as unmapped.
		const unmapped = findings.filter((f) => f.message.includes("no D1 mapping delivers to it"));
		expect(unmapped.map((f) => f.message)).toEqual([expect.stringContaining('"correo-imsanti"')]);
	});

	it("flags a mapping whose thread the registry does not know", () => {
		const findings = compareTopicRegistry({
			boundChatId: HQ,
			registryChatId: HQ,
			registry: registry(),
			mappings: [
				...MAPPINGS,
				{ chatId: HQ, mailboxId: "mbx_n", address: "billing@acme.test", topicId: 77 },
			],
		});
		const missing = findings.find((f) => f.message.includes("billing@acme.test"));
		expect(missing?.status).toBe("warn");
		expect(missing?.message).toContain("missing from the tg-hq registry");
		expect(missing?.fix).toContain("tg-hq adopt <slug> 77");
	});

	it("labels a mapping whose mailbox row is gone by its id", () => {
		const findings = compareTopicRegistry({
			boundChatId: HQ,
			registryChatId: HQ,
			registry: [],
			mappings: [{ chatId: HQ, mailboxId: "mbx_gone", address: null, topicId: 9 }],
		});
		expect(findings[0]?.message).toContain("mbx_gone (mailbox row missing)");
		expect(findings[0]?.status).toBe("warn");
	});

	it("warns on mailbox-looking registry entries with no D1 mapping, not on others", () => {
		const findings = compareTopicRegistry({
			boundChatId: HQ,
			registryChatId: HQ,
			registry: registry(),
			mappings: [MAPPINGS[0]] as TopicMapping[],
		});
		const warned = findings.filter((f) => f.status === "warn").map((f) => f.message);
		expect(warned).toHaveLength(2);
		expect(warned[0]).toContain('"correo-imsanti"');
		expect(warned[1]).toContain('"correo-transcribo"');
		expect(warned.join(" ")).not.toContain("citta-ops");
	});

	it("is an info line when there is nothing to compare", () => {
		const [finding] = compareTopicRegistry({
			boundChatId: HQ,
			registryChatId: HQ,
			registry: [{ slug: "citta-ops", id: 6, name: "Citta ops" }],
			mappings: [],
		});
		expect(finding?.status).toBe("info");
	});
});
