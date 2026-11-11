import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { insertOpsEvent } from "../db/d1";
import { McpMailboxFacade } from "./mailbox-facade";
import type { McpAuthContext } from "./scopes";

export async function readAuditedResource(
	env: Env,
	auth: McpAuthContext,
	mailboxId: string,
	messageId: string,
	attachmentId?: string,
): Promise<{ blob: string; mimeType: string }> {
	const facade = new McpMailboxFacade(env, auth);
	const started = Date.now();
	let reason: string | null = null;
	try {
		return await facade.readResource(mailboxId, messageId, attachmentId);
	} catch (error) {
		reason = error instanceof Error ? error.message : "internal_error";
		throw error;
	} finally {
		try {
			await insertOpsEvent(env.INDEX_DB, {
				id: crypto.randomUUID(),
				event_type: "mcp.resource_read",
				severity: reason ? "warning" : "info",
				subject: auth.email,
				payload_json: JSON.stringify({
					mailbox_id: mailboxId,
					resource: attachmentId ? "attachment" : "raw_mime",
					scope: "mail:read",
					denied: Boolean(reason),
					reason,
					latency_ms: Date.now() - started,
				}),
			});
		} catch {
			/* Audit failure must not reveal or block resource content. */
		}
	}
}

export function registerResources(server: McpServer, env: Env, auth: McpAuthContext): void {
	const register = (attachment: boolean) => {
		const template = attachment
			? "reccado://mailboxes/{mailboxId}/messages/{messageId}/attachments/{attachmentId}"
			: "reccado://mailboxes/{mailboxId}/messages/{messageId}/raw";
		server.registerResource(
			attachment ? "attachment" : "raw_mime",
			new ResourceTemplate(template, { list: undefined }),
			{},
			async (uri, variables) => {
				const result = await readAuditedResource(
					env,
					auth,
					String(variables.mailboxId),
					String(variables.messageId),
					attachment ? String(variables.attachmentId) : undefined,
				);
				return { contents: [{ uri: uri.href, ...result }] };
			},
		);
	};
	register(false);
	register(true);
}
