import type { z } from "zod";
import type { AuthContext } from "../api/auth";
import { AdminError, parseAdmin } from "./admin/errors";
import type { IntentField, IntentWarning } from "./approvals";

export type Operation = Record<string, unknown>;
export type Rendered = {
	title: string;
	fields: IntentField[];
	warnings: IntentWarning[];
	/**
	 * Dotted payload paths (`body.scopes`) this render shows the owner. A path covers itself
	 * and everything below it. Payload leaves not covered are appended raw by
	 * `renderWithSafetyNet`, so a kind can never hide a field the owner approves.
	 */
	covers?: string[];
};
export type ApprovalMode = "required" | "direct";
export type ControlPlaneKind = {
	/**
	 * `required`: irreversible / exfiltrating, so it pends until the owner approves it (owner web
	 * session, on `/approve/:id` or in the inbox approvals pane).
	 * `direct`: applied immediately with the token's scope (before-snapshot + ops event kept).
	 * A function decides from the (validated) payload.
	 */
	approval:
		| ApprovalMode
		| ((env: Env, auth: AuthContext, payload: Operation) => Promise<ApprovalMode>);
	/** Static payload paths this kind always renders (merged with `Rendered.covers`). */
	covers?: string[];
	validate: (payload: unknown) => Operation;
	render: (env: Env, auth: AuthContext, payload: Operation) => Promise<Rendered>;
	execute: (env: Env, auth: AuthContext, payload: Operation) => Promise<unknown>;
	/**
	 * Splits an execute result into what may be persisted/shown to the agent (`stored`) and
	 * one-time secrets (`secrets`) that go only into the owner's approve HTTP response.
	 */
	redact?: (result: unknown) => { stored: unknown; secrets?: IntentField[] };
	/**
	 * Fields describing a decided request's outcome (what was asked and what came of it), for
	 * the approval page once there is nothing left to approve. Gets the frozen payload and the
	 * stored execution item; must not throw and must not show secrets.
	 */
	describeOutcome?: (payload: Operation, item: ExecutionItem) => IntentField[];
};

/** One stored execution result, as `approvals.result_json.items[n]` keeps it. */
export type ExecutionItem = {
	status: "executed" | "failed" | "not_run";
	result?: unknown;
	errorCode?: string;
	detail?: Record<string, unknown>;
};

/**
 * A kind's reasoned refusal: `code` is the stable reason, `detail` (no secrets) is stored with
 * the failed execution so the approval page and the agent's status poll can say why and what
 * to do. Thrown from `render` it refuses the request before any approval exists.
 */
export class ControlPlaneRefusal extends AdminError {
	constructor(
		message: string,
		code: string,
		status: number,
		readonly detail: Record<string, unknown>,
	) {
		super(message, code, status);
		this.name = "ControlPlaneRefusal";
	}
}

const registry = new Map<string, ControlPlaneKind>();
export function registerControlPlaneKind(kind: string, definition: ControlPlaneKind): void {
	if (!/^[a-z][a-z0-9_]{0,31}$/.test(kind) || kind === "send" || registry.has(kind))
		throw new Error("invalid_intent_kind");
	registry.set(kind, definition);
}
export async function approvalModeFor(
	kind: ControlPlaneKind,
	env: Env,
	auth: AuthContext,
	payload: Operation,
): Promise<ApprovalMode> {
	return typeof kind.approval === "function" ? kind.approval(env, auth, payload) : kind.approval;
}
export function controlPlaneKind(kind: string): ControlPlaneKind | undefined {
	return registry.get(kind);
}

export function operation(value: unknown, keys: string[]): Operation {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new AdminError("Invalid payload", "validation_error", 400);
	const row = value as Operation;
	if (Object.keys(row).some((key) => !keys.includes(key)))
		throw new AdminError("Invalid payload", "validation_error", 400);
	return row;
}
/** Strict (unknown keys refused) schema validation; output is plain JSON. */
export function strict<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
	return parseAdmin(schema, value);
}
export function show(value: unknown): string {
	return value == null ? "(vacío)" : String(value);
}

function leafPaths(value: unknown, path: string, out: Array<[string, unknown]>): void {
	if (Array.isArray(value) && value.some((item) => item && typeof item === "object")) {
		value.forEach((item, i) => leafPaths(item, path ? `${path}.${i}` : String(i), out));
	} else if (value && typeof value === "object" && !Array.isArray(value)) {
		const entries = Object.entries(value);
		if (entries.length === 0 && path) out.push([path, value]);
		for (const [key, child] of entries) leafPaths(child, path ? `${path}.${key}` : key, out);
	} else if (path) out.push([path, value]);
}
const isCovered = (path: string, covers: string[]) =>
	covers.some((c) => path === c || path.startsWith(`${c}.`));

/** Raw "campo: valor" rows for every payload leaf the kind did not declare as rendered. */
export function unrenderedFields(payload: Operation, covers: string[]): IntentField[] {
	const leaves: Array<[string, unknown]> = [];
	leafPaths(payload, "", leaves);
	return leaves
		.filter(([path]) => !isCovered(path, covers))
		.map(([path, value]) => ({
			label: `campo: ${path}`,
			value: typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined"),
			format: "pre" as const,
		}));
}

export async function renderWithSafetyNet(
	kind: ControlPlaneKind,
	env: Env,
	auth: AuthContext,
	payload: Operation,
): Promise<Rendered> {
	const rendered = await kind.render(env, auth, payload);
	const extra = unrenderedFields(payload, [...(kind.covers ?? []), ...(rendered.covers ?? [])]);
	return extra.length ? { ...rendered, fields: [...rendered.fields, ...extra] } : rendered;
}
