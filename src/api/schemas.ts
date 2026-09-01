import { z } from "zod";
import {
	KEY_SHAPE_MESSAGES,
	SEND_SCOPE_REQUIRES_TEMPLATE_ALLOWLIST,
	SEND_SCOPE_REQUIRES_TEMPLATES_USE,
	sendScopeHasTemplateAllowlist,
	sendScopeHasTemplateUse,
} from "../lib/transactional-keys";

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

// Control-plane PATCH bodies. Every field is optional so a caller can send only what changed,
// and the refine rejects `{}`: an empty patch is almost always a misspelled field name, and
// answering 200 to one would hide the bug behind a response that looks like it applied.
// `nullable()` where the column is nullable, so a patch can clear a value — an omitted key means
// "leave alone" and an explicit null means "write NULL", a distinction `?? existing` would lose.
const nonEmptyPatch = (body: object) => Object.keys(body).length > 0;
const nonEmptyPatchMessage = { message: "Provide at least one field to update" };

export const updateMailboxSchema = z
	.object({
		displayName: z.string().trim().min(1).max(120).nullable().optional(),
		status: z.enum(["active", "disabled"]).optional(),
	})
	.refine(nonEmptyPatch, nonEmptyPatchMessage);

export const updateDomainSchema = z.object({
	status: z.enum(["pending", "active", "disabled"]),
});

export const updateAliasSchema = z.object({
	status: z.enum(["active", "disabled"]),
});

export const updateRoutingRuleSchema = z
	.object({
		pattern: z.string().min(1).optional(),
		priority: z.number().int().min(0).optional(),
		action: z.enum(["store", "forward", "reject"]).optional(),
		mailboxId: z.string().min(1).nullable().optional(),
		forwardTo: z.array(z.string().email()).optional(),
		rejectReason: z.string().nullable().optional(),
		enabled: z.boolean().optional(),
	})
	.refine(nonEmptyPatch, nonEmptyPatchMessage);

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
	/** The message being answered, so the reply's In-Reply-To points at it rather
	 * than at whatever arrived in the thread most recently. */
	parentMessageId: z.string().optional(),
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

// A key that can send is usable only if it can also render templates and names at
// least one. The send path enforces both, but only at the first real send — which
// is hours or days after the secret was handed out, and answers a bare 403. Refuse
// the combination at creation instead, while the operator is still looking at the
// form that produced it.
//
// Refuse rather than quietly complete: adding `transactional:templates:use` on the
// caller's behalf would leave the stored scope list describing something nobody
// asked for, and scopes on a credential are the record auditors read.
export const createTransactionalApiKeySchema = z
	.object({
		environment: z.enum(["test", "live"]),
		sender: z.string().email(),
		scopes: z.array(transactionalApiKeyScopeSchema).min(1),
		// `.min(1)` per entry so a blank line cannot pad the allowlist into looking non-empty.
		templateAllowlist: z.array(z.string().min(1)).optional(),
		recipientPolicy: z.string().optional(),
		quotaMax: z.number().int().positive().optional(),
		expiresAt: z.string().datetime().optional(),
	})
	.superRefine((body, ctx) => {
		if (!sendScopeHasTemplateUse(body.scopes)) {
			ctx.addIssue({
				code: "custom",
				path: ["scopes"],
				message: `${SEND_SCOPE_REQUIRES_TEMPLATES_USE}: ${KEY_SHAPE_MESSAGES[SEND_SCOPE_REQUIRES_TEMPLATES_USE]}`,
			});
		}
		if (!sendScopeHasTemplateAllowlist(body.scopes, body.templateAllowlist)) {
			ctx.addIssue({
				code: "custom",
				path: ["templateAllowlist"],
				message: `${SEND_SCOPE_REQUIRES_TEMPLATE_ALLOWLIST}: ${KEY_SHAPE_MESSAGES[SEND_SCOPE_REQUIRES_TEMPLATE_ALLOWLIST]}`,
			});
		}
	});
