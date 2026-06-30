import { once } from "node:events";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

const outputPath = process.argv[2] ?? ".tmp/large-email-near-limit.eml";
const targetMiB = Number(process.argv[3] ?? "24");

if (!Number.isFinite(targetMiB) || targetMiB <= 0) {
	console.error("Usage: pnpm generate:large-mime [outputPath] [targetMiB]");
	process.exit(1);
}

const targetBytes = Math.floor(targetMiB * 1024 * 1024);
const boundary = "phase0_5_large_mime_boundary";
const header = [
	"From: Large Fixture <sender@example.com>",
	"To: test@example.com",
	"Subject: Phase 0.5 large MIME smoke",
	"Message-ID: <phase-0.5-large-smoke@example.com>",
	"Date: Tue, 30 Jun 2026 16:30:00 +0000",
	"MIME-Version: 1.0",
	`Content-Type: multipart/mixed; boundary="${boundary}"`,
	"",
	`--${boundary}`,
	"Content-Type: text/plain; charset=utf-8",
	"Content-Transfer-Encoding: 7bit",
	"",
	"This deterministic body pads the message near the Email Routing inbound limit.",
	"",
].join("\r\n");
const footer = [
	"",
	`--${boundary}`,
	'Content-Type: text/plain; name="tiny.txt"',
	'Content-Disposition: attachment; filename="tiny.txt"',
	"Content-Transfer-Encoding: 7bit",
	"",
	"attachment marker",
	`--${boundary}--`,
	"",
].join("\r\n");
const fillerLine = "phase0.5-large-mime-padding-0123456789abcdefghijklmnopqrstuvwxyz\r\n";
const headerBytes = Buffer.byteLength(header);
const footerBytes = Buffer.byteLength(footer);
const fillerBytes = Buffer.byteLength(fillerLine);

if (targetBytes <= headerBytes + footerBytes) {
	throw new Error(`target too small; minimum is ${headerBytes + footerBytes + fillerBytes} bytes`);
}

mkdirSync(dirname(outputPath), { recursive: true });

const stream = createWriteStream(outputPath, { flags: "w" });

async function write(chunk: string) {
	if (!stream.write(chunk)) {
		await once(stream, "drain");
	}
}

await write(header);
let written = headerBytes;
const footerReserve = footerBytes;

while (written + footerReserve + fillerBytes <= targetBytes) {
	await write(fillerLine);
	written += fillerBytes;
}

const remaining = targetBytes - written - footerReserve;
if (remaining > 0) {
	await write("x".repeat(remaining));
	written += remaining;
}

await write(footer);
stream.end();
await once(stream, "finish");

const size = statSync(outputPath).size;
console.log(
	JSON.stringify(
		{
			outputPath,
			targetMiB,
			targetBytes,
			size,
			sizeMiB: Number((size / 1024 / 1024).toFixed(3)),
			messageId: "phase-0.5-large-smoke@example.com",
		},
		null,
		2,
	),
);
