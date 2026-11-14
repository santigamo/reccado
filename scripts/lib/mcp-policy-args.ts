/**
 * `pnpm operator mcp policy <set|show|rm>` argument parsing. `--mailbox` takes one or more
 * ids (repeatable); `--kinds` and `--link-domains` take comma lists.
 */
export type PolicyCommand =
	| { action: "set"; clientId: string; mailboxIds: string[]; kinds: string[]; linkDomains: string[]; allowVariableLinks: boolean; maxAutoPerHour?: number }
	| { action: "show"; clientId?: string }
	| { action: "rm"; clientId: string };

const VALUE_FLAGS = new Set(["client", "mailbox", "kinds", "link-domains", "max-per-hour", "env", "host", "email"]);
const list = (value: string) => value.split(",").map((v) => v.trim()).filter(Boolean);

export function parsePolicyArgs(argv: readonly string[]): PolicyCommand {
	const [action, ...rest] = argv;
	if (action !== "set" && action !== "show" && action !== "rm") throw new Error("mcp policy requires set, show or rm");
	const values = new Map<string, string[]>();
	let allowVariableLinks = false;
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i]!;
		if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
		const [key, inline] = token.slice(2).split("=", 2) as [string, string | undefined];
		if (key === "allow-variable-links") {
			allowVariableLinks = inline === undefined || inline === "true";
			continue;
		}
		if (!VALUE_FLAGS.has(key)) throw new Error(`unknown flag: --${key}`);
		const taken = values.get(key) ?? [];
		if (inline !== undefined) taken.push(inline);
		else if (key === "mailbox") {
			// Several ids may follow one --mailbox.
			while (rest[i + 1] && !rest[i + 1]!.startsWith("--")) taken.push(rest[(i += 1)]!);
		} else if (rest[i + 1] && !rest[i + 1]!.startsWith("--")) taken.push(rest[(i += 1)]!);
		if (!taken.length) throw new Error(`--${key} requires a value`);
		values.set(key, taken);
	}
	const one = (key: string) => values.get(key)?.at(-1);
	const clientId = one("client");
	if (action === "show") return { action, clientId };
	if (!clientId) throw new Error("--client <client_id> is required");
	if (action === "rm") return { action, clientId };
	const mailboxIds = values.get("mailbox")?.flatMap(list) ?? [];
	const kinds = list(one("kinds") ?? "");
	if (!mailboxIds.length) throw new Error("--mailbox <id>... is required");
	if (!kinds.length) throw new Error("--kinds a,b is required");
	const max = one("max-per-hour");
	if (max !== undefined && !/^\d+$/.test(max)) throw new Error("--max-per-hour must be an integer");
	return { action, clientId, mailboxIds, kinds, linkDomains: list(one("link-domains") ?? ""), allowVariableLinks, maxAutoPerHour: max === undefined ? undefined : Number(max) };
}
