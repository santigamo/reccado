import { createApiApp } from "../api/hono";
import { assertAdminAccess } from "../lib/admin/access";
import * as mailboxes from "../lib/admin/mailboxes";
import * as domains from "../lib/admin/domains";
import * as routing from "../lib/admin/routing";
import * as templates from "../lib/admin/templates";
import * as keys from "../lib/admin/api-keys";
import * as ops from "../lib/admin/ops";
import * as suppressions from "../lib/admin/suppressions";
import { listMailboxesByOwner } from "../db/d1";
import { templateContentHash } from "../lib/template-hash";
import type { McpAuthContext } from "./scopes";

const SECRET_FIELDS = new Set([
	"key_hash",
	"keyhash",
	"secret",
	"plaintextkey",
	"plaintext_key",
	"rawkey",
	"pepper",
]);

/** Drop key material wherever a control-plane payload nests it. */
export function stripConfigSecrets<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => stripConfigSecrets(item)) as T;
	if (!value || typeof value !== "object") return value;
	const cleaned: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (SECRET_FIELDS.has(key.toLowerCase())) continue;
		cleaned[key] = stripConfigSecrets(entry);
	}
	return cleaned as T;
}

export async function health(env: Env, auth: McpAuthContext, origin: string) {
	assertAdminAccess(env, auth, "");
	const response = await createApiApp().fetch(new Request(new URL("/api/health", origin)), env);
	if (!response.ok) throw new Error("internal_error");
	return (await response.json()) as Record<string, unknown>;
}

type StoredTemplate = {
	id: string;
	subject: string;
	body_text: string | null;
	body_html: string | null;
	[key: string]: unknown;
};

/** A template without its bodies: their sizes and the content hash (`templateContentHash`) instead. */
async function templateSummary(row: StoredTemplate) {
	const { body_text, body_html, ...rest } = row;
	return {
		...rest,
		sha256: await templateContentHash(row),
		body_text_chars: body_text?.length ?? 0,
		body_html_chars: body_html?.length ?? 0,
	};
}

/**
 * `templates: "summary"` leaves template bodies out (sizes + sha256 instead), so an agent can
 * verify a sync by hash without downloading every body.
 */
export async function config(
	env: Env,
	auth: McpAuthContext,
	options: { templates?: "full" | "summary" } = {},
) {
	const [mailboxRows, domainRows, aliasRows, rules, owned] = await Promise.all([
		mailboxes.listMailboxes(env, auth),
		domains.listDomains(env, auth),
		routing.listAliases(env, auth),
		routing.listRules(env, auth, {}),
		listMailboxesByOwner(env.INDEX_DB, auth.email),
	]);
	const mailboxDetails = await Promise.all(
		owned.map(async (mailbox) => {
			const listed = (await templates.listTemplates(env, auth, { mailboxId: mailbox.mailbox_id }))
				.value as { templates?: StoredTemplate[] } | undefined;
			return {
				mailboxId: mailbox.mailbox_id,
				templates:
					options.templates === "summary"
						? { templates: await Promise.all((listed?.templates ?? []).map(templateSummary)) }
						: listed,
				keys: (await keys.listKeys(env, auth, { mailboxId: mailbox.mailbox_id })).value,
			};
		}),
	);
	return stripConfigSecrets({
		...mailboxRows,
		...domainRows,
		...aliasRows,
		...rules,
		mailboxDetails,
	});
}

export async function operations(
	env: Env,
	auth: McpAuthContext,
	input: {
		kind: "events" | "dlq" | "suppressions";
		mailboxId?: string;
		limit: number;
		offset: number;
		eventType?: string;
	},
) {
	if (input.kind !== "suppressions")
		return ops.listOpsPage(env, auth, { ...input, kind: input.kind });
	assertAdminAccess(env, auth, "");
	const owned = input.mailboxId
		? [{ mailbox_id: input.mailboxId }]
		: await listMailboxesByOwner(env.INDEX_DB, auth.email);
	const suppressionRows = (
		await Promise.all(
			owned.map(async (mailbox) => {
				const data = (
					await suppressions.listSuppressions(env, auth, { mailboxId: mailbox.mailbox_id })
				).value as { suppressions?: Array<Record<string, unknown>> } | null;
				return (data?.suppressions ?? []).map((row) => ({
					mailboxId: mailbox.mailbox_id,
					...row,
				}));
			}),
		)
	).flat();
	return { suppressions: suppressionRows.slice(input.offset, input.offset + input.limit) };
}
