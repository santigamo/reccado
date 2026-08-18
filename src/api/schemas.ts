import { z } from "zod";

export const createMailboxSchema = z.object({
	primaryAddress: z.string().email(),
	displayName: z.string().trim().min(1).max(120).optional(),
});

export const createAliasSchema = z.object({
	aliasAddress: z.string().email(),
	mailboxId: z.string().min(1),
});

export const createDomainSchema = z.object({
	domain: z.string().min(3),
	zoneId: z.string().min(1),
});

export const createRoutingRuleSchema = z.object({
	domainId: z.string().min(1),
	pattern: z.string().min(1),
	priority: z.number().int().min(0),
	action: z.enum(["store", "forward", "reject"]),
	mailboxId: z.string().optional(),
	forwardTo: z.array(z.string().email()).optional(),
	rejectReason: z.string().optional(),
	enabled: z.boolean().default(true),
});

export const messageActionSchema = z.object({
	action: z.enum(["mark_read", "mark_unread", "archive", "trash", "restore_inbox"]),
});

export const createDraftSchema = z.object({
	to: z.array(z.string().email()).min(1),
	cc: z.array(z.string().email()).optional(),
	bcc: z.array(z.string().email()).optional(),
	subject: z.string().min(1),
	bodyText: z.string().optional(),
	bodyHtml: z.string().optional(),
	threadId: z.string().optional(),
});

export const updateDraftSchema = createDraftSchema.partial();

export const confirmSendSchema = z.object({
	idempotencyKey: z.string().min(1),
});

export const searchQuerySchema = z.object({
	q: z.string().min(1),
	limit: z.coerce.number().int().min(1).max(100).default(25),
	cursor: z.string().optional(),
});

export const threadListQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(25),
	cursor: z.string().optional(),
	q: z.string().optional(),
	label: z.string().optional(),
	// Folder filter. `draft` is excluded — drafts live in outbound_drafts, not messages.
	state: z.enum(["inbox", "archive", "trash", "sent"]).optional(),
});

export const adminMailboxActionSchema = z.object({
	mailboxId: z.string().min(1),
});

// Transactional API key schemas

export const transactionalApiKeyScopeSchema = z.enum([
	"transactional:send",
	"transactional:status",
	"transactional:templates:use",
]);

export const createTransactionalApiKeySchema = z.object({
	environment: z.enum(["test", "live"]),
	sender: z.string().email(),
	scopes: z.array(transactionalApiKeyScopeSchema).min(1),
	templateAllowlist: z.array(z.string()).optional(),
	recipientPolicy: z.string().optional(),
	quotaMax: z.number().int().positive().optional(),
	expiresAt: z.string().datetime().optional(),
});
