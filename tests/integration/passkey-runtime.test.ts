import { env } from "cloudflare:workers";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { expect, it } from "vitest";
import migration from "../../migrations/d1/0016_better_auth.sql?raw";
import authUpgrade from "../../migrations/d1/0021_better_auth_1_7_20.sql?raw";
import passkeyMigration from "../../migrations/d1/0024_passkey.sql?raw";
import { applyMigrations } from "../helpers/migrations";

it("generates passkey authentication options on the Workers runtime", async () => {
	await applyMigrations(env.INDEX_DB, migration, authUpgrade, passkeyMigration);
	const auth = betterAuth({
		database: env.INDEX_DB as never,
		secret: "test-secret-0123456789-0123456789-0123",
		baseURL: "https://example.com",
		plugins: [passkey({ rpID: "example.com", origin: "https://example.com", authenticatorSelection: { userVerification: "required" } })],
	});
	const response = await auth.handler(new Request("https://example.com/api/auth/passkey/generate-authenticate-options"));
	expect(response.status).toBe(200);
	const options = await response.json() as { challenge: string; userVerification: string };
	expect(options.challenge.length).toBeGreaterThan(20);
	expect(options.userVerification).toBe("required");
});
