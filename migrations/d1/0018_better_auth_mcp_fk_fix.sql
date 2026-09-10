-- 0018_better_auth_mcp_fk_fix.sql
-- Corrects the foreign keys written by 0017. The oauth-provider plugin does not
-- reference the synthetic id of oauthClient/oauthResource: it writes
-- oauthClient.clientId (the external client id) and oauthResource.identifier.
-- Verified against @better-auth/oauth-provider@1.7.3 schema (references with
-- model/field/onDelete); D1 enforces FKs, so client registration failed with
-- "FOREIGN KEY constraint failed" and token issuance would too. SQLite cannot
-- alter an FK, so the four affected tables are recreated. All four were empty
-- outside tests at the time this landed.
--
-- Reference map (canonical):
--   oauthClientResource.clientId   -> oauthClient(clientId)      ON DELETE CASCADE
--   oauthClientResource.resourceId -> oauthResource(identifier)  ON DELETE CASCADE
--   oauthRefreshToken.clientId     -> oauthClient(clientId)
--   oauthRefreshToken.sessionId    -> session(id)                ON DELETE SET NULL
--   oauthAccessToken.clientId      -> oauthClient(clientId)
--   oauthAccessToken.sessionId     -> session(id)                ON DELETE SET NULL
--   oauthAccessToken.refreshId     -> oauthRefreshToken(id)
--   oauthConsent.clientId          -> oauthClient(clientId)
--   oauthConsent.userId            -> user(id)

DROP TABLE IF EXISTS "oauthClientResource";
DROP TABLE IF EXISTS "oauthAccessToken";
DROP TABLE IF EXISTS "oauthRefreshToken";
DROP TABLE IF EXISTS "oauthConsent";

CREATE TABLE "oauthClientResource" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
  "resourceId" TEXT REFERENCES "oauthResource"("identifier") ON DELETE CASCADE,
  "metadata" TEXT,
  "createdAt" INTEGER
);

CREATE TABLE "oauthAccessToken" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "token" TEXT UNIQUE,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId"),
  "sessionId" TEXT REFERENCES "session"("id") ON DELETE SET NULL,
  "userId" TEXT REFERENCES "user"("id"),
  "referenceId" TEXT,
  "authorizationCodeId" TEXT,
  "resources" TEXT,
  "requestedUserInfoClaims" TEXT,
  "refreshId" TEXT REFERENCES "oauthRefreshToken"("id"),
  "expiresAt" INTEGER,
  "createdAt" INTEGER,
  "revoked" INTEGER,
  "confirmation" TEXT,
  "scopes" TEXT NOT NULL
);

CREATE TABLE "oauthRefreshToken" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "token" TEXT UNIQUE NOT NULL,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId"),
  "sessionId" TEXT REFERENCES "session"("id") ON DELETE SET NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id"),
  "referenceId" TEXT,
  "authorizationCodeId" TEXT,
  "resources" TEXT,
  "requestedUserInfoClaims" TEXT,
  "expiresAt" INTEGER,
  "createdAt" INTEGER,
  "revoked" INTEGER,
  "rotatedAt" INTEGER,
  "rotationReplayResponse" TEXT,
  "rotationReplayExpiresAt" INTEGER,
  "authTime" INTEGER,
  "confirmation" TEXT,
  "scopes" TEXT NOT NULL
);

CREATE TABLE "oauthConsent" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient"("clientId"),
  "userId" TEXT REFERENCES "user"("id"),
  "referenceId" TEXT,
  "resources" TEXT,
  "requestedUserInfoClaims" TEXT,
  "scopes" TEXT NOT NULL,
  "createdAt" INTEGER,
  "updatedAt" INTEGER
);
