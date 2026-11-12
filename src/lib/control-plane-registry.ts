import type { z } from "zod";
import type { AuthContext } from "../api/auth";
import type { IntentField, IntentWarning } from "./approvals";
import { AdminError, parseAdmin } from "./admin/errors";

export type Operation = Record<string, unknown>;
export type Rendered = { title: string; fields: IntentField[]; warnings: IntentWarning[] };
export type ControlPlaneKind = {
	validate: (payload: unknown) => Operation;
	render: (env: Env, auth: AuthContext, payload: Operation) => Promise<Rendered>;
	execute: (env: Env, auth: AuthContext, payload: Operation) => Promise<unknown>;
	/**
	 * Splits an execute result into what may be persisted/shown to the agent (`stored`) and
	 * one-time secrets (`secrets`) that go only into the owner's approve HTTP response.
	 */
	redact?: (result: unknown) => { stored: unknown; secrets?: IntentField[] };
};

const registry = new Map<string, ControlPlaneKind>();
export function registerControlPlaneKind(kind: string, definition: ControlPlaneKind): void {
	if (!/^[a-z][a-z0-9_]{0,31}$/.test(kind) || kind === "send" || registry.has(kind))
		throw new Error("invalid_intent_kind");
	registry.set(kind, definition);
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
