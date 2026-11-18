import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getApproval, getMailboxForOwner, insertOpsEvent } from "../db/d1";
import { buildApprovalUrl, getOrCreatePendingIntent } from "../lib/approvals";
import { assertPendingCapacity } from "../lib/control-plane-intents";
import { mailboxStub } from "../lib/mailbox-stub";
import { notifyIntentCreated } from "../telegram/notify";
import { mcpToolError, mcpToolResultJson } from "./errors";
import {
	respondWithIntent,
	resolveIntentRetry,
	statusForIntent,
	type IntentFlow,
} from "./intent-flow";
import { assertScope, scopeFilteredServer } from "./scopes";
import type { McpSendAuth } from "./types";

const rates = new Map<string, number>();

export function registerSendTool(
	rawServer: McpServer,
	env: Env,
	auth: McpSendAuth,
	origin: string,
	flow?: IntentFlow,
) {
	const server = scopeFilteredServer(rawServer, auth);
	server.registerTool(
		"send",
		{
			description:
				"Request human approval to send an agent-created draft (from save_draft), or check an existing intent. The owner reviews the exact message, formatted version included, and nothing is sent unless they approve it; you can never send or approve it yourself. The owner may instead send the saved draft themselves from their web inbox: the request then reads stale and the draft is already sent. A draft the owner edited is theirs and answers draft_not_agent_owned.",
			inputSchema: z.object({
				mailboxId: z.string().min(1),
				draftId: z.string().min(1),
				intentId: z.string().min(1).optional(),
			}),
			outputSchema: z.record(z.string(), z.unknown()),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async (params, ctx) => {
			const start = Date.now();
			let intentId: string | undefined;
			let reason: string | undefined;
			try {
				assertScope(auth, "mail:send");
				const key = `${auth.email}:send:${Math.floor(Date.now() / 60000)}`;
				const count = rates.get(key) ?? 0;
				if (count >= 10) throw new Error("rate_limited");
				rates.set(key, count + 1);
				const minute = String(Math.floor(Date.now() / 60000));
				for (const k of rates.keys()) if (!k.endsWith(`:${minute}`)) rates.delete(k);
				const mailbox = await getMailboxForOwner(env.INDEX_DB, params.mailboxId, auth.email);
				if (!mailbox) throw new Error("not_found");
				const retry = ctx ? resolveIntentRetry(ctx) : undefined;
				if (retry && params.intentId && retry !== params.intentId)
					throw new Error("invalid_request_state");
				intentId = retry ?? params.intentId;
				if (intentId) {
					const row = await getApproval(env.INDEX_DB, intentId);
					if (
						!row ||
						row.kind !== "send" ||
						row.origin !== "mcp" ||
						row.mailbox_id !== params.mailboxId ||
						row.draft_id !== params.draftId
					)
						throw new Error("not_found");
					if ((row.token_sub ?? null) !== (auth.tokenSub ?? null)) throw new Error("not_found");
					const status = await statusForIntent(env, intentId);
					if (retry && status.status === "pending" && flow && ctx) {
						const approvalUrl = buildApprovalUrl(origin, intentId);
						if (!approvalUrl) throw new Error("invalid_origin");
						return await respondWithIntent(flow, ctx, {
							intentId,
							expiresAt: row.expires_at,
							approvalUrl,
							message: `Aprueba el envío en Telegram o revísalo en ${new URL(origin).host}`,
						});
					}
					return mcpToolResultJson(status);
				}
				const stub = mailboxStub(env, params.mailboxId);
				const path = `https://mailbox-do/drafts/${encodeURIComponent(params.draftId)}`;
				const response = await stub.fetch(path);
				if (!response.ok) throw new Error("not_found");
				const { draft } = (await response.json()) as {
					draft: { origin?: string; status?: string } | null;
				};
				if (!draft) throw new Error("not_found");
				if (draft.origin !== "mcp") throw new Error("draft_not_agent_owned");
				if (draft.status !== "draft" && draft.status !== "pending_confirmation")
					throw new Error("draft_not_editable");
				const requested = await stub.fetch(`${path}/request-send`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						mailboxAddress: mailbox.primary_address,
						displayName: mailbox.display_name,
						// Re-checked atomically in the DO: a draft the owner took over is not the agent's to send.
						requester: "mcp",
					}),
				});
				if (!requested.ok) throw new Error("request_send_failed");
				const frozen = (await requested.json()) as { payload_hash?: string; error?: string };
				if (!frozen.payload_hash || frozen.error)
					throw new Error(frozen.error ?? "request_send_failed");
				await assertPendingCapacity(env, auth.tokenSub, {
					mailboxId: params.mailboxId,
					draftId: params.draftId,
				});
				const { intent, created } = await getOrCreatePendingIntent(env, {
					kind: "send",
					origin: "mcp",
					mailboxId: params.mailboxId,
					draftId: params.draftId,
					payloadHash: frozen.payload_hash,
					oauthClientId: auth.oauthClientId,
					tokenSub: auth.tokenSub,
					tokenJti: auth.tokenJti,
				});
				intentId = intent.id;
				if (created) await notifyIntentCreated(env, intent.id).catch(() => undefined);
				const status = await statusForIntent(env, intent.id);
				if (status.status !== "pending") return mcpToolResultJson(status);
				const approvalUrl = buildApprovalUrl(origin, intent.id);
				if (!approvalUrl) throw new Error("invalid_origin");
				if (!flow || !ctx)
					return mcpToolResultJson({
						status: "pending",
						intentId: intent.id,
						approvalUrl,
						expiresAt: intent.expiresAt,
					});
				return await respondWithIntent(flow, ctx, {
					intentId: intent.id,
					expiresAt: intent.expiresAt,
					approvalUrl,
					message: `Aprueba el envío en Telegram o revísalo en ${new URL(origin).host}`,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : "internal_error";
				reason =
					/^(insufficient_scope: [a-z:]+|rate_limited|too_many_pending_approvals|not_found|draft_not_agent_owned|draft_not_editable|invalid_request_state|intent_stale)$/.test(
						message,
					)
						? message
						: "internal_error";
				return mcpToolError(reason);
			} finally {
				await insertOpsEvent(env.INDEX_DB, {
					id: crypto.randomUUID(),
					event_type: "mcp.tool_call",
					severity: reason ? "warning" : "info",
					subject: auth.email,
					payload_json: JSON.stringify({
						tool: "send",
						scope: "mail:send",
						mailbox_id: params.mailboxId,
						intent_id: intentId ?? null,
						denied: Boolean(reason),
						reason: reason ?? null,
						latency_ms: Date.now() - start,
					}),
				}).catch(() => undefined);
			}
		},
	);
}
