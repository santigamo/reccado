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

type VerificationConfig = {
	configEnv: "production" | "dev";
	worker: string;
	r2: string;
	queue: string;
	dlq: string;
	d1: string;
	d1Id: string;
	emailSendingDomain: string;
	routingDomain: string;
	routingAddress: string;
	doBinding: string;
	r2Binding: string;
	queueBinding: string;
	d1Binding: string;
	emailBinding: string;
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

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg?.startsWith("--")) continue;
		const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
		if (!rawKey) continue;
		if (inlineValue !== undefined) {
			args[rawKey] = inlineValue;
			continue;
		}
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			args[rawKey] = "true";
			continue;
		}
		args[rawKey] = next;
		i += 1;
	}
	return args;
}

function resolveString(
	args: Record<string, string>,
	argName: string,
	envName: string,
	fallback: string,
): string {
	return args[argName] ?? process.env[envName] ?? fallback;
}

const args = parseArgs(process.argv.slice(2));
const configEnvArg = args.env ?? process.env.CF_VERIFY_ENV ?? "dev";
assert(
	configEnvArg === "dev" || configEnvArg === "production",
	`Invalid env ${configEnvArg}; expected "dev" or "production"`,
);

const defaultConfigByEnv: Record<
	VerificationConfig["configEnv"],
	Omit<VerificationConfig, "configEnv">
> = {
	dev: {
		worker: "reccado-dev",
		r2: "inbox-mcp-raw-dev",
		queue: "inbox-mcp-inbound-dev",
		dlq: "inbox-mcp-inbound-dlq-dev",
		d1: "inbox-mcp-index-dev",
		// Placeholder — pass your real dev D1 id via CF_VERIFY_D1_ID (or --d1-id).
		d1Id: "00000000-0000-0000-0000-000000000000",
		emailSendingDomain: "mail.example.com",
		routingDomain: "example.com",
		routingAddress: "test@example.com",
		doBinding: "MAILBOX_DO",
		r2Binding: "MAIL_OBJECTS",
		queueBinding: "INBOUND_EMAIL_QUEUE",
		d1Binding: "INDEX_DB",
		emailBinding: "EMAIL",
	},
	production: {
		worker: "reccado",
		r2: "inbox-mcp-raw",
		queue: "inbox-mcp-inbound",
		dlq: "inbox-mcp-inbound-dlq",
		d1: "inbox-mcp-index",
		d1Id: "<your-prod-d1-database-id>",
		emailSendingDomain: "mail.example.com",
		routingDomain: "example.com",
		routingAddress: "test@example.com",
		doBinding: "MAILBOX_DO",
		r2Binding: "MAIL_OBJECTS",
		queueBinding: "INBOUND_EMAIL_QUEUE",
		d1Binding: "INDEX_DB",
		emailBinding: "EMAIL",
	},
};

const defaults = defaultConfigByEnv[configEnvArg];
const required: VerificationConfig = {
	configEnv: configEnvArg,
	worker: resolveString(args, "worker", "CF_VERIFY_WORKER", defaults.worker),
	r2: resolveString(args, "r2", "CF_VERIFY_R2_BUCKET", defaults.r2),
	queue: resolveString(args, "queue", "CF_VERIFY_QUEUE", defaults.queue),
	dlq: resolveString(args, "dlq", "CF_VERIFY_DLQ", defaults.dlq),
	d1: resolveString(args, "d1", "CF_VERIFY_D1_NAME", defaults.d1),
	d1Id: resolveString(args, "d1-id", "CF_VERIFY_D1_ID", defaults.d1Id),
	emailSendingDomain: resolveString(
		args,
		"email-sending-domain",
		"CF_VERIFY_EMAIL_SENDING_DOMAIN",
		defaults.emailSendingDomain,
	),
	routingDomain: resolveString(
		args,
		"routing-domain",
		"CF_VERIFY_ROUTING_DOMAIN",
		defaults.routingDomain,
	),
	routingAddress: resolveString(
		args,
		"routing-address",
		"CF_VERIFY_ROUTING_ADDRESS",
		defaults.routingAddress,
	),
	doBinding: resolveString(args, "do-binding", "CF_VERIFY_DO_BINDING", defaults.doBinding),
	r2Binding: resolveString(args, "r2-binding", "CF_VERIFY_R2_BINDING", defaults.r2Binding),
	queueBinding: resolveString(
		args,
		"queue-binding",
		"CF_VERIFY_QUEUE_BINDING",
		defaults.queueBinding,
	),
	d1Binding: resolveString(args, "d1-binding", "CF_VERIFY_D1_BINDING", defaults.d1Binding),
	emailBinding: resolveString(
		args,
		"email-binding",
		"CF_VERIFY_EMAIL_BINDING",
		defaults.emailBinding,
	),
};

// The repo ships a placeholder D1 id (public template). Fail early with an actionable message
// instead of querying Cloudflare for a UUID no real account can have.
if (required.d1Id === "00000000-0000-0000-0000-000000000000" || required.d1Id === "") {
	console.error(
		"verify:cf: INDEX_DB database_id is a placeholder. Pass your real id via CF_VERIFY_D1_ID " +
			"(or --d1-id), e.g. CF_VERIFY_D1_ID=<uuid> pnpm verify:cf.",
	);
	process.exit(1);
}

const config = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as WranglerConfig;
const envConfig = required.configEnv === "dev" ? (config.env?.dev ?? {}) : {};
const merged: WranglerConfig = { ...config, ...envConfig };

assert(config.main === "src/server.ts", "wrangler main must be src/server.ts");
assert(config.compatibility_date === "2026-06-30", "compatibility_date mismatch");
assert(config.compatibility_flags?.includes("nodejs_compat"), "nodejs_compat flag missing");
assert(config.observability?.enabled === true, "observability.enabled missing");
if (required.configEnv === "dev") {
	assert(envConfig.name === required.worker, "env.dev.name mismatch");
} else {
	assert(config.name === required.worker, "top-level worker name mismatch");
}
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

const routingRules = runWrangler(["email", "routing", "rules", "list", required.routingDomain]);
assert(routingRules.includes(required.routingAddress), "Email Routing test alias missing");
assert(routingRules.includes(required.worker), "Email Routing worker action missing");

console.log(
	JSON.stringify(
		{
			ok: true,
			env: required.configEnv,
			worker: required.worker,
			resources: {
				r2: required.r2,
				queue: required.queue,
				dlq: required.dlq,
				d1: required.d1,
				d1Id: required.d1Id,
				emailSendingDomain: required.emailSendingDomain,
				routingDomain: required.routingDomain,
				routingAddress: required.routingAddress,
				cron: merged.triggers?.crons,
				emailBinding: required.emailBinding,
			},
		},
		null,
		2,
	),
);
