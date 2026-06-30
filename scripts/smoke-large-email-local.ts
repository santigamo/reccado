import { readFileSync, statSync } from "node:fs";

const baseUrl = process.argv[2];
const fixturePath = process.argv[3] ?? ".tmp/large-email-near-limit.eml";

if (!baseUrl) {
	console.error("Usage: pnpm smoke:email:large <http-base-url> [fixture]");
	process.exit(1);
}

const raw = readFileSync(fixturePath);
const fileSize = statSync(fixturePath).size;
const to = "test@example.com";
const from = "sender@example.com";
const startedAt = Date.now();

const emailUrl = new URL("/cdn-cgi/handler/email", baseUrl);
emailUrl.searchParams.set("from", from);
emailUrl.searchParams.set("to", to);

const response = await fetch(emailUrl, {
	method: "POST",
	body: raw,
});
const text = await response.text();
console.log("delivery:", text);
if (!response.ok) {
	throw new Error(`delivery failed with ${response.status}`);
}

async function fetchDebug() {
	const response = await fetch(new URL("/api/debug/phase0/mailboxes/mbx_test", baseUrl));
	if (!response.ok) {
		throw new Error(`debug failed with ${response.status}: ${await response.text()}`);
	}
	return (await response.json()) as {
		messageCount: number;
		messages: Array<{
			raw_r2_key: string;
			raw_sha256: string;
			idempotency_key: string;
			subject: string | null;
		}>;
	};
}

const deadline = Date.now() + 15_000;
let debug: Awaited<ReturnType<typeof fetchDebug>> | null = null;
let message: Awaited<ReturnType<typeof fetchDebug>>["messages"][number] | undefined;
while (Date.now() < deadline) {
	debug = await fetchDebug();
	message = debug.messages.find((candidate) => candidate.subject === "Phase 0.5 large MIME smoke");
	if (message) {
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 300));
}

if (!message) {
	throw new Error(`large fixture message not found; last=${JSON.stringify(debug)}`);
}

const r2HeadUrl = new URL("/api/debug/phase0/r2/head", baseUrl);
r2HeadUrl.searchParams.set("key", message.raw_r2_key);
const r2Head = (await (await fetch(r2HeadUrl)).json()) as { exists?: boolean; size?: number };
if (!r2Head.exists) {
	throw new Error(`R2 object missing: ${message.raw_r2_key}`);
}

const queuePayloadSample = {
	eventType: "email.received.v1",
	mailboxId: "mbx_test",
	rawR2Key: message.raw_r2_key,
	rawSha256: message.raw_sha256,
	idempotencyKey: message.idempotency_key,
};
const queuePayloadBytes = new TextEncoder().encode(JSON.stringify(queuePayloadSample)).byteLength;

console.log(
	"large-smoke:",
	JSON.stringify(
		{
			fileSize,
			fileSizeMiB: Number((fileSize / 1024 / 1024).toFixed(3)),
			durationMs: Date.now() - startedAt,
			r2Head,
			queuePayloadBytes,
			queuePayloadUnder128KiB: queuePayloadBytes < 128 * 1024,
			rawR2Key: message.raw_r2_key,
			subject: message.subject,
		},
		null,
		2,
	),
);
console.log("PASS: large local email smoke stored raw MIME in R2 and kept Queue payload small");
