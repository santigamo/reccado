import { readFileSync } from "node:fs";

const baseUrlArg = process.argv[2];
const fixturePath = process.argv[3] ?? "fixtures/mime/simple-text.eml";

if (!baseUrlArg) {
	console.error("Usage: pnpm smoke:email:local <http-base-url> [fixture]");
	process.exit(1);
}

const baseUrl: string = baseUrlArg;

const raw = readFileSync(fixturePath);
const to = "test@example.com";
const from = "sender@example.com";
const emailUrl = new URL("/cdn-cgi/handler/email", baseUrl);
emailUrl.searchParams.set("from", from);
emailUrl.searchParams.set("to", to);

async function postFixture(label: string) {
	const response = await fetch(emailUrl, {
		method: "POST",
		body: raw,
	});
	const text = await response.text();
	console.log(`${label}:`, text);
	if (!response.ok) {
		throw new Error(`${label} failed with ${response.status}`);
	}
}

async function fetchDebug(baseUrl: string) {
	const mailboxResponse = await fetch(new URL("/api/debug/phase0/test-mailbox-id", baseUrl));
	const { mailboxId } = (await mailboxResponse.json()) as { mailboxId: string };
	const response = await fetch(new URL(`/api/debug/phase0/mailboxes/${mailboxId}`, baseUrl));
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

async function waitForMessageCount(expected: number) {
	const deadline = Date.now() + 10_000;
	let lastDebug: Awaited<ReturnType<typeof fetchDebug>> | null = null;
	while (Date.now() < deadline) {
		lastDebug = await fetchDebug(baseUrl);
		if (lastDebug.messageCount === expected) {
			return lastDebug;
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error(`messageCount did not become ${expected}; last=${JSON.stringify(lastDebug)}`);
}

await postFixture("first-delivery");
const firstDebug = await waitForMessageCount(1);
const message = firstDebug.messages[0];
if (!message) {
	throw new Error("missing message after first delivery");
}

const r2HeadUrl = new URL("/api/debug/phase0/r2/head", baseUrl);
r2HeadUrl.searchParams.set("key", message.raw_r2_key);
const r2Head = (await (await fetch(r2HeadUrl)).json()) as { exists?: boolean };
console.log("r2-head:", JSON.stringify(r2Head));
if (!r2Head.exists) {
	throw new Error(`R2 object missing: ${message.raw_r2_key}`);
}

await postFixture("duplicate-delivery");
const duplicateDebug = await waitForMessageCount(1);

console.log("debug:", JSON.stringify(duplicateDebug));
console.log(
	"queue-payload-sample:",
	JSON.stringify({
		eventType: "email.received.v1",
		mailboxId: message.idempotency_key.split(":")[2] ?? "unknown",
		rawR2Key: message.raw_r2_key,
		rawSha256: message.raw_sha256,
		idempotencyKey: message.idempotency_key,
	}),
);
console.log("PASS: local email smoke completed with one DO message after duplicate delivery");
