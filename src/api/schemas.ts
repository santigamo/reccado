import { z } from "zod";
import {
	isValidSenderName,
	KEY_SHAPE_MESSAGES,
	MAX_SENDER_NAME_LENGTH,
	SEND_SCOPE_REQUIRES_TEMPLATE_ALLOWLIST,
	SEND_SCOPE_REQUIRES_TEMPLATES_USE,
	sendScopeHasTemplateAllowlist,
	sendScopeHasTemplateUse,
} from "../lib/transactional-keys";
import { MAX_TEMPLATE_SYNC_BATCH, validateRecipientPolicy } from "../lib/transactional-send";

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

/**
 * One provisioning request. The zone comes from the URL, and the sending domain
 * is composed from `subdomain` rather than accepted whole: a caller who could
 * name the sending domain freely could aim records at a zone other than the one
 * in the path.
 *
 * `dmarc.policy` has no default on purpose. Choosing between monitoring and
 * enforcement is the one judgement in this flow that has consequences for mail
 * that is already flowing, so it is stated every time rather than inherited.
 */
export const provisionDomainSchema = z.object({
	subdomain: z
		.string()
		.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i, "subdomain must be a single DNS label")
		.default("send"),
	dmarc: z.object({
		policy: z.enum(["none", "quarantine", "reject"]),
		alignment: z.enum(["relaxed", "strict"]).optional(),
		rua: z.string().email().optional(),
	}),
	inbound: z.boolean().default(false),
	mailbox: z
		.object({
			address: z.string().email(),
			displayName: z.string().optional(),
			ownerEmail: z.string().email().optional(),
		})
		.optional(),
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
/**
 * The From display phrase, e.g. "Eccos" in `Eccos <hello@notify.eccos.chat>`.
 *
 * Validated here as well as in the storage layer because this value ends up in a
 * mail header: CR/LF would let it inject additional headers, and angle brackets
 * or quotes would break the address form. Rejecting it at the edge means the
 * operator sees the problem on the form they typed it into.
 */
const senderNameField = z.string().trim().max(MAX_SENDER_NAME_LENGTH).refine(isValidSenderName, {
	message: "Sender name must be printable ASCII without angle brackets or double quotes",
});

export const updateTransactionalApiKeySchema = z.object({
	// Explicitly nullable: null clears the name back to sending the bare address,
	// which an operator must be able to do without reissuing the key.
	senderName: senderNameField.nullable(),
});

/**
 * Collection-level template sync. Only the shape, the batch cap and duplicate ids
 * are checked here; the per-template rules (id characters, CR/LF in subject, body
 * length) are applied by the mailbox DO — the same function its create route
 * uses — before it writes anything.
 */
export const syncTransactionalTemplatesSchema = z
	.object({
		templates: z
			.array(
				z.object({
					id: z.string().min(1),
					subject: z.string().min(1),
					body_text: z.string().nullable().optional(),
					body_html: z.string().nullable().optional(),
				}),
			)
			.max(MAX_TEMPLATE_SYNC_BATCH),
		archiveMissing: z.boolean().optional(),
	})
	.superRefine((body, ctx) => {
		const seen = new Set<string>();
		body.templates.forEach((template, index) => {
			if (seen.has(template.id)) {
				ctx.addIssue({
					code: "custom",
					path: ["templates", index, "id"],
					message: `duplicate_template_id: ${JSON.stringify(template.id)} appears more than once`,
				});
			}
			seen.add(template.id);
		});
	});

export const createTransactionalApiKeySchema = z
	.object({
		environment: z.enum(["test", "live"]),
		sender: z.string().email(),
		// Accepted at creation so an operator does not have to create and then
		// PATCH. Same validation as the PATCH route: this lands in a mail header.
		// null (or omitted) means the bare address, as on PATCH.
		senderName: senderNameField.nullable().optional(),
		scopes: z.array(transactionalApiKeyScopeSchema).min(1),
		// `.min(1)` per entry so a blank line cannot pad the allowlist into looking non-empty.
		templateAllowlist: z.array(z.string().min(1)).optional(),
		recipientPolicy: z.string().optional(),
		quotaMax: z.number().int().positive().optional(),
		expiresAt: z.string().datetime().optional(),
	})
	.superRefine((body, ctx) => {
		// A malformed policy is not an error at send time — it is a rule that never
		// matches, so every recipient is rejected with no hint why. Refuse it here.
		if (body.recipientPolicy !== undefined) {
			for (const issue of validateRecipientPolicy(body.recipientPolicy)) {
				ctx.addIssue({
					code: "custom",
					path: ["recipientPolicy"],
					message: `invalid_recipient_policy: rule ${JSON.stringify(issue.rule)}: ${issue.reason}`,
				});
			}
		}
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

/**
 * A Telegram chat id as the operator types it: the numeric id (negative for
 * groups, -100... for supergroups) or a public @username. The route stores the
 * numeric id getChat answers with, never the typed form.
 */
const telegramChatIdSchema = z
	.union([z.number().int(), z.string().trim()])
	.transform((value) => String(value))
	.pipe(
		z
			.string()
			.regex(
				/^(-?\d{1,20}|@[A-Za-z0-9_]{4,32})$/,
				"a numeric Telegram chat id (e.g. -1001234567890) or a public @username",
			),
	);

/**
 * Map a mailbox to a forum topic in the bound chat. `adoptThreadId` records an
 * existing thread (with `name` as its optional stored label); otherwise `name`
 * is required and a topic is created under it. 128 is Telegram's own limit.
 */
export const telegramTopicSchema = z
	.object({
		mailboxId: z.string().trim().min(1),
		name: z.string().trim().min(1).max(128).optional(),
		adoptThreadId: z.number().int().positive().optional(),
		replace: z.boolean().optional(),
		dryRun: z.boolean().optional(),
	})
	.strict()
	.refine((body) => body.name !== undefined || body.adoptThreadId !== undefined, {
		message: "give name (create a topic) or adoptThreadId (map an existing one)",
		path: ["name"],
	});

/** POST /api/telegram/test: every active mailbox, or just this one. */
export const telegramDeliveryTestSchema = z
	.object({ mailboxId: z.string().trim().min(1).optional() })
	.strict();

export const telegramRebindSchema = z
	.object({
		chatId: telegramChatIdSchema,
		/** Check everything with Telegram and report, but write nothing. */
		dryRun: z.boolean().optional(),
	})
	.strict();
