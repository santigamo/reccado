import { createRequestStateCodec, inputRequired, type RequestStateCodec, type ServerContext } from "@modelcontextprotocol/server";
import { getIntentStatus } from "../lib/approvals";
import { hmacSha256 } from "../lib/crypto";
import { mcpToolResultJson } from "./errors";

export type IntentFlow = { era: "legacy" | "modern"; codec: RequestStateCodec<{ intentId: string }> };

export async function makeIntentCodec(secret: string, principal: string) {
	return createRequestStateCodec<{ intentId: string }>({
		key: await hmacSha256(secret, "mcp-request-state.v1"),
		bind: () => principal,
	});
}

export async function respondWithIntent(flow: IntentFlow, ctx: ServerContext, input: { intentId: string; expiresAt: string; approvalUrl: string; message: string }) {
	if (flow.era === "legacy") return mcpToolResultJson({ status: "pending", intentId: input.intentId, approvalUrl: input.approvalUrl, expiresAt: input.expiresAt });
	return inputRequired({
		inputRequests: { approval: inputRequired.elicitUrl({ url: input.approvalUrl, message: input.message }) },
		requestState: await flow.codec.mint({ intentId: input.intentId }, ctx),
	});
}

/** The SDK verification hook has already authenticated this state. */
export function resolveIntentRetry(ctx: ServerContext): string | undefined {
	const state = ctx.mcpReq.requestState<unknown>();
	if (state === undefined) return undefined;
	if (!state || typeof state !== "object" || !("intentId" in state) || typeof state.intentId !== "string" || !state.intentId) throw new Error("invalid_request_state");
	return state.intentId;
}

export async function statusForIntent(env: Env, id: string) {
	const result = await getIntentStatus(env, id);
	return { status: result.status, intentId: id,
		...(result.send?.providerMessageId ? { sentMessageId: result.send.providerMessageId } : {}),
		...(result.deliveryFeedback ? { deliveryFeedback: result.deliveryFeedback } : {}),
		...(result.send?.errorCode ? { error: result.send.errorCode } : {}),
	};
}
