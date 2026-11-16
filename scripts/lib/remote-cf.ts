/**
 * Remote Cloudflare helpers for operator scripts that read prod/dev D1 + R2 through
 * wrangler and push to a Queue through the REST API (publishing has no wrangler
 * command). Same invocations as scripts/reingest-mailbox.ts, which still carries
 * its own copy.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export function wranglerRun(args: string[]): string {
	return execFileSync("pnpm", ["wrangler", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
	});
}

/** SQLite string literal for the few values that are interpolated into SQL. */
export function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Read-only `d1 execute --remote --json --command`. `--command` (not `--file`) because
 * an uploaded file's response carries a summary instead of the rows.
 */
export function d1Select<T>(database: string, sql: string, extraArgs: string[] = []): T[] {
	if (!/^\s*select\b/i.test(sql)) throw new Error("d1Select only runs SELECT statements");
	const raw = wranglerRun([
		"d1",
		"execute",
		database,
		"--remote",
		"--json",
		"--command",
		sql,
		...extraArgs,
	]);
	const start = raw.indexOf("[");
	if (start === -1) throw new Error(`unexpected wrangler d1 output:\n${raw}`);
	const parsed = JSON.parse(raw.slice(start)) as Array<{ results?: T[] }>;
	return parsed[0]?.results ?? [];
}

/** One raw object, or null only for a genuine miss (any other failure is rethrown). */
export function fetchRawObject(
	bucket: string,
	key: string,
	dir: string,
	jurisdiction: string | undefined,
): Uint8Array | null {
	const file = join(dir, "object.eml");
	rmSync(file, { force: true });
	try {
		wranglerRun([
			"r2",
			"object",
			"get",
			`${bucket}/${key}`,
			"--remote",
			"--file",
			file,
			...(jurisdiction ? ["--jurisdiction", jurisdiction] : []),
		]);
	} catch (error) {
		const output = [
			error instanceof Error ? error.message : String(error),
			(error as { stdout?: Buffer | string }).stdout?.toString() ?? "",
			(error as { stderr?: Buffer | string }).stderr?.toString() ?? "",
		].join("\n");
		if (/not\s*found|404|NoSuchKey|does not exist|specified key/i.test(output)) return null;
		throw new Error(`r2 get failed for ${key}:\n${output}`);
	}
	return new Uint8Array(readFileSync(file));
}

export async function cfApi<T>(token: string, path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	const payload = (await response.json()) as {
		success?: boolean;
		result?: T;
		errors?: Array<{ message?: string; code?: number }>;
	};
	if (!response.ok || payload.success !== true) {
		const detail = (payload.errors ?? [])
			.map((item) => `${item.message ?? "unknown error"}${item.code ? ` [${item.code}]` : ""}`)
			.join("; ");
		throw new Error(detail || `Cloudflare API request failed (${response.status})`);
	}
	return payload.result as T;
}

export function resolveAccountId(): string | undefined {
	const fromEnv = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	if (fromEnv) return fromEnv;
	try {
		const payload = JSON.parse(wranglerRun(["whoami", "--json"])) as {
			account?: { id?: string };
			accounts?: Array<{ id?: string }>;
		};
		return payload.account?.id ?? payload.accounts?.[0]?.id;
	} catch {
		return undefined;
	}
}

export async function resolveQueueId(
	token: string,
	accountId: string,
	queueName: string,
): Promise<string> {
	const queues = await cfApi<Array<Record<string, unknown>>>(
		token,
		`/accounts/${accountId}/queues`,
	);
	for (const queue of queues) {
		const name = (queue.queue_name ?? queue.name) as string | undefined;
		const id = (queue.queue_id ?? queue.id) as string | undefined;
		if (name === queueName && id) return id;
	}
	throw new Error(`queue ${queueName} not found in account ${accountId}`);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
