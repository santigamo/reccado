import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import auth from "../../migrations/d1/0016_better_auth.sql?raw";
import oauth from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
import oauthFix from "../../migrations/d1/0018_better_auth_mcp_fk_fix.sql?raw";
import twoFactor from "../../migrations/d1/0019_two_factor.sql?raw";
import upgrade from "../../migrations/d1/0021_better_auth_1_7_20.sql?raw";
import { applyMigrations } from "../helpers/migrations";

describe("Better Auth 1.7.20 upgrade migration", () => {
	it("preserves existing credentials, sessions, TOTP and OAuth clients across repeated application", async () => {
		const db = env.INDEX_DB;
		await applyMigrations(db, auth, oauth, oauthFix, twoFactor);
		await db
			.prepare(
				`INSERT INTO "user" (id,name,email,emailVerified,twoFactorEnabled) VALUES ('u','User','upgrade@example.test',1,1)`,
			)
			.run();
		await db
			.prepare(
				`INSERT INTO "account" (id,issuer,accountId,providerId,userId,password,updatedAt) VALUES ('a','local:credential','u','credential','u','password-hash',1)`,
			)
			.run();
		await db
			.prepare(
				`INSERT INTO "session" (id,expiresAt,token,updatedAt,userId) VALUES ('s',9999999999,'token',1,'u')`,
			)
			.run();
		await db
			.prepare(
				`INSERT INTO "twoFactor" (id,secret,backupCodes,userId) VALUES ('t','secret','codes','u')`,
			)
			.run();
		await db
			.prepare(
				`INSERT INTO "oauthClient" (id,clientId,userId,redirectUris) VALUES ('c','client','u','[]')`,
			)
			.run();
		await db
			.prepare(
				`INSERT INTO "oauthConsent" (id,clientId,userId,scopes) VALUES ('consent','client','u','[]')`,
			)
			.run();
		await db
			.prepare(
				`INSERT INTO "oauthRefreshToken" (id,token,clientId,userId,sessionId,scopes) VALUES ('refresh','refresh-token','client','u','s','[]')`,
			)
			.run();
		await db
			.prepare(
				`INSERT INTO "oauthAccessToken" (id,token,clientId,userId,sessionId,refreshId,scopes) VALUES ('access','access-token','client','u','s','refresh','[]')`,
			)
			.run();
		await applyMigrations(db, upgrade, upgrade);
		expect(await db.prepare(`SELECT issuer,password FROM "account" WHERE id='a'`).first()).toEqual({
			issuer: "local:credential",
			password: "password-hash",
		});
		for (const [table, id] of [
			["user", "u"],
			["session", "s"],
			["twoFactor", "t"],
			["oauthClient", "c"],
			["oauthConsent", "consent"],
			["oauthRefreshToken", "refresh"],
			["oauthAccessToken", "access"],
		]) {
			expect(await db.prepare(`SELECT id FROM "${table}" WHERE id=?`).bind(id).first()).toEqual({
				id,
			});
		}
		await db
			.prepare(
				`INSERT INTO "account" (id,accountId,providerId,userId,updatedAt) VALUES ('a2','u','other','u',1)`,
			)
			.run();
		expect(
			(await db.prepare(`SELECT count(*) AS count FROM "account"`).first<{ count: number }>())
				?.count,
		).toBe(2);
	});
});
