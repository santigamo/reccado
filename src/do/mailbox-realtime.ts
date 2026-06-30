type WebSocketAttachment = {
	mailboxId: string;
	userId?: string;
	lastSeenSeq?: number;
};

type ClientWsEnvelope = {
	v?: number;
	id?: string;
	type?: string;
	payload?: unknown;
};

export type RealtimeBroadcaster = {
	broadcast: (envelope: Record<string, unknown>) => void;
};

export function createRealtimeBroadcaster(
	getWebSockets: () => WebSocket[],
	mailboxId: string,
	getLatestSeq: () => number,
): RealtimeBroadcaster {
	return {
		broadcast(envelope) {
			const seq = getLatestSeq();
			const message = JSON.stringify({
				v: 1,
				...envelope,
				mailboxId,
				seq,
				ts: new Date().toISOString(),
			});
			for (const ws of getWebSockets()) {
				try {
					ws.send(message);
				} catch {
					// closed socket
				}
			}
		},
	};
}

export async function handleWebSocketMessage(
	ws: WebSocket,
	message: string | ArrayBuffer,
	mailboxId: string,
	connectionCount: number,
): Promise<void> {
	const text = typeof message === "string" ? message : new TextDecoder().decode(message);
	try {
		const parsed = JSON.parse(text) as ClientWsEnvelope;
		if (parsed.type === "ping") {
			ws.send(
				JSON.stringify({
					v: 1,
					type: "pong",
					mailboxId,
					seq: 0,
					ts: new Date().toISOString(),
					payload: { connectionCount },
				}),
			);
			return;
		}
		if (parsed.type === "request_snapshot") {
			ws.send(
				JSON.stringify({
					v: 1,
					type: "mailbox.snapshot",
					mailboxId,
					seq: 0,
					ts: new Date().toISOString(),
					payload: { connectionCount, note: "use HTTP threads API for full snapshot" },
				}),
			);
			return;
		}
	} catch {
		// fall through
	}

	ws.send(
		JSON.stringify({
			v: 1,
			type: "echo",
			mailboxId,
			seq: 0,
			ts: new Date().toISOString(),
			payload: { connectionCount, text },
		}),
	);
}

export function sendHello(ws: WebSocket, mailboxId: string, connectionCount: number): void {
	ws.send(
		JSON.stringify({
			v: 1,
			type: "hello",
			mailboxId,
			seq: 0,
			ts: new Date().toISOString(),
			payload: { connectionCount },
		}),
	);
}

export type { WebSocketAttachment };
