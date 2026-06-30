import { describe, expect, it, vi } from "vitest";
import { handleInboundQueue } from "#/cloudflare/queue-consumer";
import type { InboundEmailQueueMessage } from "#/cloudflare/types";

describe("queue consumer", () => {
	it("retries invalid schema messages instead of acking poison messages", async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		const bind = vi.fn(() => ({ run }));
		const prepare = vi.fn(() => ({ bind }));
		const retry = vi.fn();
		const ack = vi.fn();
		const message = {
			id: "poison-1",
			attempts: 3,
			body: { schemaVersion: 999 },
			retry,
			ack,
		};

		await handleInboundQueue(
			{ messages: [message] } as unknown as MessageBatch<InboundEmailQueueMessage>,
			{ INDEX_DB: { prepare } } as unknown as Env,
			{} as ExecutionContext,
		);

		expect(prepare).toHaveBeenCalledWith(
			"INSERT INTO ops_events (id, event_type, severity, subject, payload_json, created_at)\n       VALUES (?, ?, ?, ?, ?, ?)",
		);
		expect(retry).toHaveBeenCalledWith({ delaySeconds: 2 });
		expect(ack).not.toHaveBeenCalled();
	});
});
