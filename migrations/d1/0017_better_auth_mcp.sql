-- 0017_better_auth_mcp.sql
-- Tables for the @better-auth/mcp OAuth provider plugin (id oauth-provider) and the
-- jwt() plugin (stable signing keys + /jwks), added to the auth config in the same
-- change that moves /mcp onto bearer tokens. Same conventions as 0016: camelCase
-- identifiers are better-auth's own; every table carries an id PK (validated spike).

CREATE TABLE IF NOT EXISTS "jwks" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "publicKey" TEXT NOT NULL,
  "privateKey" TEXT NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "expiresAt" INTEGER,
  "alg" TEXT,
  "crv" TEXT
);

CREATE TABLE IF NOT EXISTS "oauthClient" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT UNIQUE,
  "clientSecret" TEXT,
  "clientDiscoveryId" TEXT,
  "disabled" INTEGER,
  "skipConsent" INTEGER,
  "enableEndSession" INTEGER,
  "subjectType" TEXT,
  "scopes" TEXT,
  "clientCredentialsScopes" TEXT,
  "userId" TEXT REFERENCES "user"("id"),
  "createdAt" INTEGER,
  "updatedAt" INTEGER,
  "name" TEXT,
  "uri" TEXT,
  "icon" TEXT,
  "contacts" TEXT,
  "tos" TEXT,
  "policy" TEXT,
  "softwareId" TEXT,
  "softwareVersion" TEXT,
  "softwareStatement" TEXT,
  "redirectUris" TEXT NOT NULL,
  "postLogoutRedirectUris" TEXT,
  "backchannelLogoutUri" TEXT,
  "backchannelLogoutSessionRequired" INTEGER,
  "tokenEndpointAuthMethod" TEXT,
  "applicationType" TEXT,
  "jwks" TEXT,
  "jwksUri" TEXT,
  "grantTypes" TEXT,
  "responseTypes" TEXT,
  "requirePKCE" INTEGER,
  "dpopBoundAccessTokens" INTEGER,
  "referenceId" TEXT,
  "metadata" TEXT
);

CREATE TABLE IF NOT EXISTS "oauthResource" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "identifier" TEXT UNIQUE,
  "name" TEXT NOT NULL,
  "accessTokenTtl" INTEGER,
  "refreshTokenTtl" INTEGER,
  "signingAlgorithm" TEXT,
  "signingKeyId" TEXT,
  "allowedScopes" TEXT,
  "customClaims" TEXT,
  "dpopBoundAccessTokensRequired" INTEGER,
  "disabled" INTEGER,
  "createdAt" INTEGER,
  "updatedAt" INTEGER,
  "policyVersion" INTEGER,
  "metadata" TEXT
);

CREATE TABLE IF NOT EXISTS "oauthClientResource" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT REFERENCES "oauthClient"("id"),
  "resourceId" TEXT REFERENCES "oauthResource"("id"),
  "metadata" TEXT,
  "createdAt" INTEGER
);

CREATE TABLE IF NOT EXISTS "oauthRefreshToken" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "token" TEXT UNIQUE,
  "clientId" TEXT REFERENCES "oauthClient"("id"),
  "sessionId" TEXT REFERENCES "session"("id"),
  "userId" TEXT REFERENCES "user"("id"),
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

CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "token" TEXT UNIQUE,
  "clientId" TEXT REFERENCES "oauthClient"("id"),
  "sessionId" TEXT REFERENCES "session"("id"),
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

CREATE TABLE IF NOT EXISTS "oauthConsent" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT REFERENCES "oauthClient"("id"),
  "userId" TEXT REFERENCES "user"("id"),
  "referenceId" TEXT,
  "resources" TEXT,
  "requestedUserInfoClaims" TEXT,
  "scopes" TEXT NOT NULL,
  "createdAt" INTEGER,
  "updatedAt" INTEGER
);

CREATE TABLE IF NOT EXISTS "oauthClientAssertion" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "expiresAt" INTEGER NOT NULL
);
