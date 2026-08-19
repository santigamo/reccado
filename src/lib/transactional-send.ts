import { z } from "zod";
import { sha256Hex } from "./crypto";

const MAX_SUBJECT_LENGTH = 998;
const MAX_BODY_LENGTH = 100_000;
const MAX_VARIABLE_COUNT = 50;
const MAX_VARIABLE_VALUE_LENGTH = 10_000;
const MAX_TEMPLATE_ID_LENGTH = 120;

export const transactionalRequestSchema = z.object({
	template: z.string().min(1).max(MAX_TEMPLATE_ID_LENGTH),
	to: z.string().email(),
	variables: z
		.record(z.string(), z.string().max(MAX_VARIABLE_VALUE_LENGTH))
		.optional()
		.default({})
		.refine(
			(vars) => Object.keys(vars).length <= MAX_VARIABLE_COUNT,
			`max ${MAX_VARIABLE_COUNT} variables`,
		),
});

export type TransactionalRequest = z.infer<typeof transactionalRequestSchema>;

export const transactionalResponseStatuses = [
	"accepted",
	"sent",
	"duplicate",
	"idempotency_conflict",
	"rejected",
	"permanent_failure",
	"unknown",
] as const;
export type TransactionalResponseStatus = (typeof transactionalResponseStatuses)[number];

export type TransactionalSendResult = {
	status: TransactionalResponseStatus;
	requestId: string;
	keyId?: string;
	providerMessageId?: string | null;
	error?: string;
};

const VARIABLE_RE = /\{\{(\w+)\}\}/g;

/**
 * Collects all variable names referenced in a template's subject/body_text/body_html.
 */
export function extractTemplateVariables(template: {
	subject: string;
	body_text: string | null;
	body_html: string | null;
}): Set<string> {
	const names = new Set<string>();
	const all = [template.subject, template.body_text ?? "", template.body_html ?? ""].join(" ");
	for (const match of all.matchAll(VARIABLE_RE)) {
		names.add(match[1]!);
	}
	return names;
}

/**
 * Validates that the provided variables match the template's placeholders:
 * - Every placeholder has a value (no missing variables)
 * - Every provided variable is used in the template (no unknown variables)
 */
export type VariableValidation = {
	missing: string[];
	unknown: string[];
	ok: boolean;
};

export function validateTemplateVariables(
	template: { subject: string; body_text: string | null; body_html: string | null },
	variables: Record<string, string>,
): VariableValidation {
	const referenced = extractTemplateVariables(template);
	const provided = new Set(Object.keys(variables));
	const missing: string[] = [];
	const unknown: string[] = [];
	for (const name of referenced) {
		if (!provided.has(name)) missing.push(name);
	}
	for (const name of provided) {
		if (!referenced.has(name)) unknown.push(name);
	}
	return { missing, unknown, ok: missing.length === 0 && unknown.length === 0 };
}

/**
 * Interpolates template variables safely. Variables are HTML-escaped for the HTML
 * body (if present) and used as-is for the text body. Only subject, body_text, and
 * body_html are interpolated — headers are never affected.
 * Variable syntax: {{variableName}}
 *
 * Returns null if validation fails (subject contains CR/LF after interpolation).
 */
export function interpolateTemplate(
	template: { subject: string; body_text: string | null; body_html: string | null },
	variables: Record<string, string>,
): { subject: string; body_text: string | null; body_html: string | null } | null {
	const variableCount = Object.keys(variables).length;
	if (variableCount > MAX_VARIABLE_COUNT) return null;

	function interpolate(text: string): string {
		return text.replace(VARIABLE_RE, (_match, name: string) => {
			const value = variables[name];
			if (value === undefined) return _match;
			return value;
		});
	}

	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	function interpolateHtml(text: string): string {
		return text.replace(VARIABLE_RE, (_match, name: string) => {
			const value = variables[name];
			if (value === undefined) return _match;
			return escapeHtml(value);
		});
	}

	const subject = interpolate(template.subject).slice(0, MAX_SUBJECT_LENGTH);
	// Reject CR/LF in subject
	if (subject.includes("\r") || subject.includes("\n")) return null;

	const body_text = template.body_text
		? interpolate(template.body_text).slice(0, MAX_BODY_LENGTH)
		: null;
	const body_html = template.body_html
		? interpolateHtml(template.body_html).slice(0, MAX_BODY_LENGTH)
		: null;

	return { subject, body_text, body_html };
}

/**
 * Validates recipient against a recipient policy.
 * Policy format: simple glob patterns separated by commas.
 * E.g.: "@example.com" allows any address at example.com,
 * "user@example.com" allows exactly that address.
 * Prefix with "!" to deny (deny takes precedence).
 * If policy is null or empty, all recipients are allowed.
 */
export function checkRecipientPolicy(
	recipient: string,
	policy: string | null,
): { allowed: boolean; reason?: string } {
	if (!policy) return { allowed: true };

	const rules = policy
		.split(",")
		.map((r) => r.trim())
		.filter(Boolean);
	const canonical = recipient.trim().toLowerCase();

	const denyRules = rules.filter((r) => r.startsWith("!")).map((r) => r.slice(1));
	const allowRules = rules.filter((r) => !r.startsWith("!"));

	// Check deny rules first
	for (const rule of denyRules) {
		if (matchRule(canonical, rule)) {
			return { allowed: false, reason: "denied_by_policy" };
		}
	}

	// If there are no allow rules, the policy is deny-only
	if (allowRules.length === 0) {
		return { allowed: true };
	}

	// At least one allow rule must match
	for (const rule of allowRules) {
		if (matchRule(canonical, rule)) {
			return { allowed: true };
		}
	}

	return { allowed: false, reason: "not_allowed_by_policy" };
}

function matchRule(canonical: string, rule: string): boolean {
	const normalized = rule.trim().toLowerCase();
	if (normalized.startsWith("@")) {
		// Domain match: @example.com matches anything@example.com.
		// endsWith is sufficient — if canonical ends with "@example.com",
		// it is guaranteed to be an email at that domain.
		return canonical.endsWith(normalized);
	}
	if (normalized.includes("*")) {
		const pattern = new RegExp(`^${normalized.replace(/\*/g, ".*").replace(/\./g, "\\.")}$`);
		return pattern.test(canonical);
	}
	return canonical === normalized;
}

export type TransactionalSendContext = {
	sql: DurableObjectState["storage"]["sql"];
	transactionSync: (fn: () => void) => void;
	email: SendEmail;
	fromAddress: string;
};

/**
 * Payload string used for idempotency hash: key_id + client idempotency key
 * + serialized request body (template, to, variables).
 */
export async function transactionalPayloadHash(input: {
	keyId: string;
	clientIdempotencyKey: string;
	template: string;
	to: string;
	variables: Record<string, string>;
}): Promise<string> {
	const canonical = `${input.keyId}:${input.clientIdempotencyKey}:${JSON.stringify({
		template: input.template,
		to: input.to.toLowerCase(),
		variables: input.variables,
		sortKeys: true,
	})}`.toLowerCase();
	return sha256Hex(new TextEncoder().encode(canonical));
}

/**
 * Validates a template ID — rejects empty, too long, or containing path separators.
 */
export function validateTemplateId(templateId: string): boolean {
	if (!templateId) return false;
	if (templateId.length > MAX_TEMPLATE_ID_LENGTH) return false;
	if (/[/\\]/.test(templateId)) return false;
	if (templateId.includes("..")) return false;
	return /^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(templateId);
}
