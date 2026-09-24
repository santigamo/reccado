/**
 * The IO half of `deploy-config.ts`: read the tracked config, the generated
 * overlay (if any) and the built `dist/server/wrangler.json`, apply the overlay,
 * write it back, and re-read it to prove the file wrangler will deploy carries
 * every generated-owned value.
 *
 * Shared by `pnpm run deploy[:dev]` (scripts/deploy.ts), `setup:domain` and
 * `setup:cloud`, so there is exactly one way a generated file reaches a deploy.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	applyGeneratedOverlay,
	effectiveBlock,
	findOverlayMismatches,
	GENERATED_OWNED_FIELDS,
	type OverlayResult,
	stripJsonc,
	type WranglerBlock,
	type WranglerConfig,
} from "./deploy-config";

export const BUILT_CONFIG_PATH = "dist/server/wrangler.json";
export const TRACKED_CONFIG_PATH = "wrangler.jsonc";

export function generatedConfigPathFor(env: string | undefined): string {
	return `wrangler.generated.${env ?? "production"}.json`;
}

export function readTrackedConfig(): WranglerConfig {
	return JSON.parse(stripJsonc(readFileSync(TRACKED_CONFIG_PATH, "utf8"))) as WranglerConfig;
}

export function readGeneratedConfig(env: string | undefined): WranglerConfig | undefined {
	const path = generatedConfigPathFor(env);
	if (!existsSync(path)) return undefined;
	return JSON.parse(stripJsonc(readFileSync(path, "utf8"))) as WranglerConfig;
}

function show(value: unknown): string {
	return value === undefined ? "(unset)" : JSON.stringify(value);
}

/** Prints what the overlay did, in the same shape for every caller. */
export function printOverlayReport(result: OverlayResult, generatedPath: string): void {
	if (result.applied.length === 0) {
		console.log(`  ${generatedPath} adds nothing the tracked config does not already ship.`);
	} else {
		console.log(`  From ${generatedPath} (generated wins for the fields it owns):`);
		for (const change of result.applied) {
			console.log(`    ${change.field}: ${show(change.from)} -> ${show(change.to)}`);
		}
	}
	if (result.ignored.length > 0) {
		console.log(
			`  Ignored in ${generatedPath} (wrangler.jsonc owns these, so its value deploys):\n` +
				result.ignored.map((field) => `    ${field}`).join("\n"),
		);
	}
}

/**
 * Patches the built Worker config in place. Throws — never warns — when the
 * re-read file does not carry the generated values, or when the build targets a
 * different Worker than the tracked config names: a deploy that ships something
 * other than what it just printed is the exact silent drift this replaces.
 */
export function patchBuiltConfig(env: string | undefined): OverlayResult | null {
	const generatedPath = generatedConfigPathFor(env);
	const tracked = effectiveBlock(readTrackedConfig(), env);
	const built = JSON.parse(readFileSync(BUILT_CONFIG_PATH, "utf8")) as WranglerBlock;

	if (tracked.name && built.name !== tracked.name) {
		throw new Error(
			`${BUILT_CONFIG_PATH} targets Worker "${built.name}", but ${TRACKED_CONFIG_PATH} names "${tracked.name}" for ${env ? `env "${env}"` : "the top level"}. ` +
				`Rebuild with ${env ? `CLOUDFLARE_ENV=${env} ` : ""}pnpm run build.`,
		);
	}

	const generatedConfig = readGeneratedConfig(env);
	console.log(`\n▸ Overlay generated config onto the build\n  target: ${BUILT_CONFIG_PATH}`);
	if (!generatedConfig) {
		console.log(`  ${generatedPath} not found — deploying the tracked config exactly as built.`);
		return null;
	}
	const generated = effectiveBlock(generatedConfig, env);
	const result = applyGeneratedOverlay({ base: built, generated, tracked });
	printOverlayReport(result, generatedPath);
	writeFileSync(BUILT_CONFIG_PATH, `${JSON.stringify(result.config, null, 2)}\n`);

	const reread = JSON.parse(readFileSync(BUILT_CONFIG_PATH, "utf8")) as WranglerBlock;
	const mismatches = findOverlayMismatches(reread, generated);
	if (mismatches.length > 0) {
		throw new Error(
			`${BUILT_CONFIG_PATH} does not carry what ${generatedPath} declares:\n  ${mismatches.join("\n  ")}\n` +
				`Owned fields: ${GENERATED_OWNED_FIELDS.join("; ")}.`,
		);
	}
	console.log(`  Verified: ${BUILT_CONFIG_PATH} carries every value ${generatedPath} owns.`);
	return result;
}
