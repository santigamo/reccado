import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

type WranglerConfig = {
	name?: string;
	main?: string;
	compatibility_date?: string;
	compatibility_flags?: string[];
	observability?: { enabled?: boolean };
	upload_source_maps?: boolean;
	triggers?: { crons?: string[] };
	send_email?: Array<{ name: string }>;
	durable_objects?: { bindings?: Array<{ name: string; class_name: string }> };
	r2_buckets?: Array<{ binding: string; bucket_name: string }>;
	queues?: {
		producers?: Array<{ binding: string; queue: string }>;
		consumers?: Array<{ queue: string; dead_letter_queue?: string }>;
	};
	d1_databases?: Array<{ binding: string; database_name: string; database_id: string }>;
	env?: Record<string, Partial<WranglerConfig>>;
};

const required = {
	worker: "reccado-dev",
	r2: "inbox-mcp-raw-dev",
	queue: "inbox-mcp-inbound-dev",
	dlq: "inbox-mcp-inbound-dlq-dev",
	d1: "inbox-mcp-index-dev",
	d1Id: "ca3b5109-17bf-4a6e-9943-9892c4e04dbc",
	emailSendingDomain: "mail.example.com",
	doBinding: "MAILBOX_DO",
	r2Binding: "MAIL_OBJECTS",
	queueBinding: "INBOUND_EMAIL_QUEUE",
	d1Binding: "INDEX_DB",
	emailBinding: "EMAIL",
};

function stripJsonc(input: string): string {
	return input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function runWrangler(args: string[]): string {
	return execFileSync("pnpm", ["wrangler", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const config = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as WranglerConfig;
const dev = config.env?.dev ?? {};
const merged: WranglerConfig = { ...config, ...dev };

assert(config.main === "src/server.ts", "wrangler main must be src/server.ts");
assert(config.compatibility_date === "2026-06-30", "compatibility_date mismatch");
assert(config.compatibility_flags?.includes("nodejs_compat"), "nodejs_compat flag missing");
assert(config.observability?.enabled === true, "observability.enabled missing");
assert(dev.name === required.worker, "env.dev.name mismatch");
assert(merged.triggers?.crons?.length, "Cron trigger missing");
assert(
	merged.send_email?.some((binding) => binding.name === required.emailBinding),
	"send_email binding missing",
);
assert(
	merged.durable_objects?.bindings?.some(
		(binding) =>
			binding.name === required.doBinding && binding.class_name === "MailboxDurableObject",
	),
	"Durable Object binding missing",
);
assert(
	merged.r2_buckets?.some(
		(bucket) => bucket.binding === required.r2Binding && bucket.bucket_name === required.r2,
	),
	"R2 binding missing",
);
assert(
	merged.queues?.producers?.some(
		(producer) => producer.binding === required.queueBinding && producer.queue === required.queue,
	),
	"Queue producer binding missing",
);
assert(
	merged.queues?.consumers?.some(
		(consumer) => consumer.queue === required.queue && consumer.dead_letter_queue === required.dlq,
	),
	"Queue consumer/DLQ binding missing",
);
assert(
	merged.d1_databases?.some(
		(db) =>
			db.binding === required.d1Binding &&
			db.database_name === required.d1 &&
			db.database_id === required.d1Id,
	),
	"D1 binding missing",
);

const buckets = runWrangler(["r2", "bucket", "list"]);
assert(buckets.includes(required.r2), `R2 bucket ${required.r2} missing`);

const queues = runWrangler(["queues", "list"]);
assert(queues.includes(required.queue), `Queue ${required.queue} missing`);
assert(queues.includes(required.dlq), `DLQ ${required.dlq} missing`);

const d1s = runWrangler(["d1", "list"]);
assert(d1s.includes(required.d1), `D1 ${required.d1} missing`);
assert(d1s.includes(required.d1Id), `D1 id ${required.d1Id} missing`);

const emailSending = runWrangler(["email", "sending", "list"]);
assert(emailSending.includes(required.emailSendingDomain), "Email Sending domain missing");
assert(emailSending.includes("yes"), "Email Sending domain is not enabled");

const routingRules = runWrangler(["email", "routing", "rules", "list", "example.com"]);
assert(routingRules.includes("test@example.com"), "Email Routing test alias missing");
assert(routingRules.includes(required.worker), "Email Routing worker action missing");

console.log(
	JSON.stringify(
		{
			ok: true,
			worker: required.worker,
			resources: {
				r2: required.r2,
				queue: required.queue,
				dlq: required.dlq,
				d1: required.d1,
				d1Id: required.d1Id,
				emailSendingDomain: required.emailSendingDomain,
				cron: merged.triggers?.crons,
				emailBinding: required.emailBinding,
			},
		},
		null,
		2,
	),
);
