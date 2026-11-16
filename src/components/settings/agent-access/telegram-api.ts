/**
 * Client for the operator Telegram routes (src/api/telegram-routes.ts). Types
 * mirror src/telegram/admin/* loosely: only the fields this UI reads.
 */

export type Probe<T> = ({ ok: true } & T) | { ok: false; error: string };

export type TelegramOperatorStatus = {
	bridge: {
		mode: "off" | "partial" | "on" | "failing";
		ok: boolean;
		missing: string[];
		reason: string | null;
	};
	bot: Probe<{ id: number; username: string | null; firstName: string }> | null;
	binding: { chatId: string | null; isForum: boolean | null };
	chat: Probe<{ id: string; type: string; title: string | null; isForum: boolean }> | null;
	membership: Probe<{ eligible: boolean; canManageTopics: boolean; reason: string }> | null;
	mailboxes: Array<{
		mailboxId: string;
		address: string;
		displayName: string | null;
		topic: { topicId: number; effectiveName: string } | null;
	}>;
};

export type DeliveryTestResult = {
	chatId: string;
	isForum: boolean;
	ok: boolean;
	results: Array<{
		mailboxId: string;
		address: string;
		outcome: "delivered_to_topic" | "fell_back_to_general" | "delivered_to_chat" | "failed";
		reason: string | null;
	}>;
};

export type RebindResult = {
	outcome: "rebound" | "unchanged" | "would_rebind" | "would_be_unchanged";
	dryRun: boolean;
	current: { chatId: string; isForum: boolean; type: string; title: string | null };
	membership: { eligible: boolean; canManageTopics: boolean; reason: string } | null;
	topics: { mappedInNewChat: number; keptForOtherChats: number };
	notes: string[];
};

export type TopicMappingResult = {
	outcome: "created" | "adopted" | "already" | "would_create" | "would_adopt";
	reason: string | null;
};

export class TelegramApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	const body = (await res.json().catch(() => null)) as
		| (T & { error?: unknown; message?: unknown })
		| null;
	if (!res.ok) {
		const code = typeof body?.error === "string" ? body.error : `http_${res.status}`;
		const message = typeof body?.message === "string" ? body.message : `HTTP ${res.status}`;
		throw new TelegramApiError(res.status, code, message);
	}
	return body as T;
}

const json = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

export const telegramApi = {
	status: () => call<TelegramOperatorStatus>("/api/telegram/status"),
	test: () => call<DeliveryTestResult>("/api/telegram/test", json({})),
	rebind: (chatId: string, dryRun: boolean) =>
		call<RebindResult>("/api/telegram/rebind", json({ chatId, dryRun })),
	createTopic: (mailboxId: string, name: string) =>
		call<TopicMappingResult>("/api/telegram/topics", json({ mailboxId, name })),
};

export function delivered(result: DeliveryTestResult): number {
	return result.results.filter(
		(r) => r.outcome === "delivered_to_topic" || r.outcome === "delivered_to_chat",
	).length;
}
