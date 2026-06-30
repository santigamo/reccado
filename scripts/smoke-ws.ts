/**
 * WebSocket smoke test.
 * Usage: pnpm smoke:ws ws://localhost:3001/api/mailboxes/<mailboxId>/ws
 */
const url = process.argv[2];
if (!url) {
	console.error("Usage: pnpm smoke:ws <ws-url>");
	process.exit(1);
}

const mailboxMatch = url.match(/\/mailboxes\/([^/]+)\/ws/);
const expectedMailboxId = mailboxMatch?.[1];
if (!expectedMailboxId) {
	console.error("Could not parse mailboxId from ws url");
	process.exit(1);
}

const timeoutMs = 15_000;
let settled = false;

function fail(message: string): never {
	if (!settled) {
		settled = true;
		console.error(`FAIL: ${message}`);
	}
	process.exit(1);
}

function pass(message: string): void {
	console.log(`OK: ${message}`);
}

function connectionCount(data: Record<string, unknown>): unknown {
	if (typeof data.connectionCount === "number") return data.connectionCount;
	const payload = data.payload as Record<string, unknown> | undefined;
	return payload?.connectionCount;
}

const timer = setTimeout(() => fail(`timed out after ${timeoutMs}ms`), timeoutMs);

const ws = new WebSocket(url);

ws.addEventListener("open", () => {
	pass("connected");
});

ws.addEventListener("message", (event) => {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(String(event.data)) as Record<string, unknown>;
	} catch {
		fail(`invalid JSON: ${String(event.data)}`);
		return;
	}

	const type = data.type;

	if (type === "hello") {
		console.log("hello:", JSON.stringify(data));
		if (data.mailboxId !== expectedMailboxId) {
			fail(`hello mailboxId expected ${expectedMailboxId}, got ${String(data.mailboxId)}`);
			return;
		}
		const count = connectionCount(data);
		if (typeof count !== "number" || count < 1) {
			fail(`hello connectionCount invalid: ${String(count)}`);
			return;
		}
		pass("received hello");
		ws.send(
			JSON.stringify({
				v: 1,
				type: "ping",
				id: "1",
				mailboxId: expectedMailboxId,
				ts: new Date().toISOString(),
				payload: {},
			}),
		);
		return;
	}

	if (type === "pong") {
		console.log("pong:", JSON.stringify(data));
		pass("received pong");
		ws.send(JSON.stringify({ type: "echo-test", payload: "phase-1-ws" }));
		return;
	}

	if (type === "echo") {
		console.log("echo:", JSON.stringify(data));
		if (data.mailboxId !== expectedMailboxId) {
			fail(`echo mailboxId expected ${expectedMailboxId}, got ${String(data.mailboxId)}`);
			return;
		}
		pass("received echo");
		clearTimeout(timer);
		settled = true;
		ws.close();
		console.log("PASS: smoke-ws completed");
		process.exit(0);
		return;
	}

	if (type === "message.created") {
		console.log("message.created:", JSON.stringify(data));
		pass("received message.created");
		return;
	}

	fail(`unexpected message type: ${String(type)}`);
});

ws.addEventListener("error", () => {
	fail("WebSocket error");
});

ws.addEventListener("close", (event) => {
	if (!settled) {
		fail(`closed before completion (code=${event.code})`);
	}
});
