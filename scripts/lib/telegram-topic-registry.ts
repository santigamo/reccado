/**
 * Comparing the owner's `tg-hq` topic registry with Reccado's D1 topic mappings.
 *
 * The Bot API cannot list a forum's topics, so a thread id lives in two places
 * once a mailbox topic exists: the `tg-hq` registry (a JSON field in 1Password,
 * slug -> { id, name }) that recorded it at creation, and D1 `telegram_topics`
 * (chat_id, mailbox_id, topic_id) that Reccado delivers to. Nothing keeps them in
 * step, and a drift is silent: Reccado posts to a thread the owner no longer
 * knows by name, or a topic the owner made for a mailbox never receives mail.
 *
 * Pure: no node APIs, no network. The doctor reads both sides and hands them in.
 * It must never probe Telegram to settle a disagreement — the only existence
 * probe the Bot API offers is `editForumTopic`, which renames the topic.
 */

export type RegistryTopic = { slug: string; id: number; name: string };

export type TopicMapping = {
	chatId: string;
	mailboxId: string;
	/** The mailbox's primary address; null when the mailbox row is gone. */
	address: string | null;
	topicId: number;
};

export type TopicFinding = {
	status: "pass" | "warn" | "info";
	message: string;
	fix?: string;
};

export type ParsedRegistry = { ok: true; topics: RegistryTopic[] } | { ok: false; error: string };

/** tg-hq's slug rule: trimmed, lowercased, whitespace runs joined by "-". */
function slugify(value: string): string {
	return value.trim().toLowerCase().split(/\s+/).filter(Boolean).join("-");
}

/**
 * The `topics` field as tg-hq validates it: an object of slug -> { id: int,
 * name: non-empty string }. Empty text is an empty registry, as in tg-hq.
 */
export function parseTopicRegistry(raw: string): ParsedRegistry {
	if (!raw.trim()) return { ok: true, topics: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, error: "the topics field is not valid JSON" };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: "the topics field is not a JSON object" };
	}
	const topics: RegistryTopic[] = [];
	for (const [slug, entry] of Object.entries(parsed as Record<string, unknown>)) {
		const value = entry as { id?: unknown; name?: unknown } | null;
		if (!value || typeof value !== "object") {
			return { ok: false, error: `entry "${slug}" is not an object` };
		}
		if (typeof value.id !== "number" || !Number.isInteger(value.id)) {
			return { ok: false, error: `entry "${slug}" has a non-integer id` };
		}
		if (typeof value.name !== "string" || !value.name.trim()) {
			return { ok: false, error: `entry "${slug}" has no usable name` };
		}
		topics.push({ slug, id: value.id, name: value.name });
	}
	topics.sort((a, b) => a.slug.localeCompare(b.slug));
	return { ok: true, topics };
}

const MAILBOX_PREFIX = /^(correo|mail|email|inbox|buzon)-/;
const MAILBOX_NAME = /^(correo|mail|e-?mail|inbox|buz[oó]n)\b/i;

/** The slug part that names the mailbox ("correo-imsanti" -> "imsanti"), or null. */
function mailboxSlugSuffix(topic: RegistryTopic): string | null {
	const slug = slugify(topic.slug);
	const bySlug = slug.match(MAILBOX_PREFIX);
	if (bySlug) return slug.slice(bySlug[0].length) || null;
	if (MAILBOX_NAME.test(topic.name.trim())) {
		const rest = slugify(
			topic.name
				.trim()
				.replace(MAILBOX_NAME, "")
				.replace(/^[\s·:–—-]+/, ""),
		);
		return rest || null;
	}
	return null;
}

/** Whether a registry entry reads as a mailbox topic ("correo-…", "Correo · …"). */
export function looksLikeMailboxTopic(topic: RegistryTopic): boolean {
	return MAILBOX_PREFIX.test(slugify(topic.slug)) || MAILBOX_NAME.test(topic.name.trim());
}

/**
 * The names an address could go by in a slug: the local part, each non-TLD
 * domain label, the domain and the whole address, all slugified with "." -> "-".
 */
function addressKeys(address: string): Set<string> {
	const clean = address.trim().toLowerCase();
	const [local = "", domain = ""] = clean.split("@");
	const labels = domain.split(".").filter(Boolean);
	const keys = new Set<string>();
	const put = (value: string) => {
		const key = slugify(value.replace(/[.@]/g, " "));
		if (key) keys.add(key);
	};
	put(local);
	for (const label of labels.slice(0, -1)) put(label);
	put(domain);
	put(clean);
	return keys;
}

/** The mailbox-looking registry entry that names this address, if exactly one does. */
function registryEntryForAddress(
	address: string | null,
	registry: RegistryTopic[],
): RegistryTopic | null {
	if (!address) return null;
	const keys = addressKeys(address);
	const hits = registry.filter((topic) => {
		const suffix = mailboxSlugSuffix(topic);
		return suffix !== null && keys.has(suffix);
	});
	return hits.length === 1 ? (hits[0] ?? null) : null;
}

function label(mapping: TopicMapping): string {
	return mapping.address ?? `${mapping.mailboxId} (mailbox row missing)`;
}

export type CompareInput = {
	/** runtime_config `telegram.chat_id`; null when the bridge adopted no chat. */
	boundChatId: string | null;
	/** The registry's `chat_id` field: the HQ forum the thread ids belong to. */
	registryChatId: string;
	registry: RegistryTopic[];
	/** Every telegram_topics row, any chat. */
	mappings: TopicMapping[];
};

/**
 * One finding per D1 mapping of the bound chat, plus a warning per mailbox-like
 * registry entry that no mapping delivers to. When the bound chat is not the
 * registry's forum the comparison is meaningless (thread ids are per chat), so it
 * returns a single info line saying which chat is bound and whether rows for the
 * HQ forum are already staged for a rebind.
 */
export function compareTopicRegistry(input: CompareInput): TopicFinding[] {
	const registryChat = input.registryChatId.trim();
	const bound = input.boundChatId?.trim() || null;
	const forHq = input.mappings.filter((m) => m.chatId.trim() === registryChat);

	if (bound !== registryChat) {
		const staged =
			forHq.length > 0
				? `${forHq.length} D1 topic mapping(s) for the HQ forum exist (${forHq
						.map((m) => `${label(m)} -> ${m.topicId}`)
						.join(", ")}), but are unused until a rebind`
				: "no D1 topic mappings exist for the HQ forum yet";
		return [
			{
				status: "info",
				message: `${bound ? `Bound chat is ${bound}` : "No chat is bound"}, not the tg-hq forum ${registryChat}; ${staged}.`,
			},
		];
	}

	const findings: TopicFinding[] = [];
	const byId = new Map(input.registry.map((topic) => [topic.id, topic]));
	for (const mapping of [...forHq].sort((a, b) => a.topicId - b.topicId)) {
		const sameId = byId.get(mapping.topicId);
		if (sameId) {
			findings.push({
				status: "pass",
				message: `${label(mapping)} -> thread ${mapping.topicId} matches tg-hq "${sameId.slug}" («${sameId.name}»).`,
			});
			continue;
		}
		const named = registryEntryForAddress(mapping.address, input.registry);
		if (named) {
			findings.push({
				status: "warn",
				message: `${label(mapping)}: thread id mismatch — D1 delivers to thread ${mapping.topicId}, tg-hq "${named.slug}" («${named.name}») records thread ${named.id}.`,
				fix: "Find out which thread is real in the Telegram app (do not probe with editForumTopic: it renames), then fix the other side.",
			});
			continue;
		}
		findings.push({
			status: "warn",
			message: `${label(mapping)} -> thread ${mapping.topicId} is missing from the tg-hq registry.`,
			fix: `tg-hq adopt <slug> ${mapping.topicId} '<topic name>' (note: adopt renames the topic to the name you pass).`,
		});
	}

	const mappedIds = new Set(forHq.map((m) => m.topicId));
	for (const topic of input.registry) {
		if (!looksLikeMailboxTopic(topic) || mappedIds.has(topic.id)) continue;
		findings.push({
			status: "warn",
			message: `tg-hq "${topic.slug}" («${topic.name}», thread ${topic.id}) looks like a mailbox topic but no D1 mapping delivers to it.`,
			fix: "Map the mailbox to that thread in telegram_topics, or `tg-hq forget` the entry if the topic is not a mailbox's.",
		});
	}

	if (findings.length === 0) {
		findings.push({
			status: "info",
			message: `No D1 topic mappings for chat ${registryChat} and no mailbox topics in the tg-hq registry.`,
		});
	}
	return findings;
}
