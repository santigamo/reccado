import type { KeyStatus } from "../lib/transactional-keys";

type SendMarkerStatus = "sending" | "sent" | "failed" | "unknown";

/**
 * The `mailbox_meta` key holding a transactional send's at-most-once marker.
 *
 * It lives here rather than next to the send because two callers need to agree on
 * it: the send path writes it, and the delivery-event path rewrites it when an
 * observed event resolves an ambiguous outcome. If those two drifted apart, a row
 * could read `sent` while its marker still said `unknown`, and the marker is what
 * a re-entrant send consults.
 */
export function transactionalSendMarkerKey(requestId: string): string {
	return `txn:v1:${requestId}`;
}

export function extractProviderMessageId(result: unknown): string | null {
	if (!result || typeof result !== "object") return null;
	const record = result as Record<string, unknown>;
	const candidates = [record.messageId, record.id, record.providerMessageId];
	const value = candidates.find((candidate) => typeof candidate === "string");
	return typeof value === "string" ? value : null;
}

export function sentMarkerValue(providerMessageId: string | null): string {
	return JSON.stringify({ status: "sent", providerMessageId });
}

export function readSendMarker(value: unknown): {
	status: SendMarkerStatus;
	providerMessageId: string | null;
	error?: string;
} {
	if (value === "sending") {
		return { status: "sending", providerMessageId: null };
	}
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as {
				status?: unknown;
				providerMessageId?: unknown;
				error?: unknown;
			};
			if (parsed.status === "unknown") {
				return {
					status: "unknown",
					providerMessageId: null,
					error: typeof parsed.error === "string" ? parsed.error : undefined,
				};
			}
			if (parsed.status === "failed") {
				return {
					status: "failed",
					providerMessageId: null,
					error: typeof parsed.error === "string" ? parsed.error : undefined,
				};
			}
			if (parsed.status === "sent") {
				return {
					status: "sent",
					providerMessageId:
						typeof parsed.providerMessageId === "string" ? parsed.providerMessageId : null,
				};
			}
		} catch {
			// Fall through to treating any unknown persisted marker as a completed send.
		}
	}
	return { status: "sent", providerMessageId: null };
}

export function rowToApiKeyRecord(row: Record<string, unknown>): {
	keyId: string;
	hashVersion: number;
	keyHash: string;
	displaySuffix: string;
	environment: "test" | "live";
	mailboxId: string;
	sender: string;
	scopes: string[];
	templateAllowlist: string[] | null;
	recipientPolicy: string | null;
	quotaMax: number | null;
	expiresAt: string | null;
	status: KeyStatus;
	createdAt: string;
	updatedAt: string;
	revokedAt: string | null;
} {
	return {
		keyId: String(row.key_id),
		hashVersion: Number(row.hash_version),
		keyHash: String(row.key_hash),
		displaySuffix: String(row.display_suffix),
		environment: String(row.environment) as "test" | "live",
		mailboxId: String(row.mailbox_id),
		sender: String(row.sender),
		scopes: JSON.parse(String(row.scopes_json)) as string[],
		templateAllowlist: row.template_allowlist_json
			? (JSON.parse(String(row.template_allowlist_json)) as string[])
			: null,
		recipientPolicy: row.recipient_policy ? String(row.recipient_policy) : null,
		quotaMax: row.quota_max != null ? Number(row.quota_max) : null,
		expiresAt: row.expires_at ? String(row.expires_at) : null,
		status: String(row.status) as KeyStatus,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		revokedAt: row.revoked_at ? String(row.revoked_at) : null,
	};
}
