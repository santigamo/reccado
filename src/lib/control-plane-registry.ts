import type { z } from "zod";
import type { AuthContext } from "../api/auth";
import type { IntentField, IntentWarning } from "./approvals";
import { AdminError, parseAdmin } from "./admin/errors";

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
export type ControlPlaneKind = {
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
			value: typeof value === "string" ? value : JSON.stringify(value) ?? "undefined",
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
