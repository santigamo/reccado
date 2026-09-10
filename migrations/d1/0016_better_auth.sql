-- 0016_better_auth.sql
-- Better Auth 1.7.2 tables (web perimeter issuer; see docs/plans/sending-streams-and-auth.md,
-- Phase 2). Identifiers are camelCase on purpose: better-auth's Kysely adapter resolves
-- table and column names from its own schema and does not map to snake_case.
--
-- Validated on the Workers runtime against a disposable D1 binding (spike):
--   - every table needs `id TEXT PRIMARY KEY` — better-auth inserts it on create,
--     including into `rateLimit`;
--   - `session.cookieCache` stores a signed `session_data` cookie and no longer reads
--     D1 per request within its maxAge;
--   - rate limiting with storage "database" writes to `rateLimit` through auth.handler
--     (direct `auth.api.*` calls bypass it).
--
-- This migration is inert to running code: nothing reads these tables until the
-- issuer swap deploys. The secret (BETTER_AUTH_SECRET) must exist before that deploy.

CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" INTEGER,
  "updatedAt" INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_email_idx" ON "user"("email");

CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" INTEGER,
  "updatedAt" INTEGER NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "session_token_idx" ON "session"("token");

CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "issuer" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id"),
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" INTEGER,
  "refreshTokenExpiresAt" INTEGER,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" INTEGER,
  "updatedAt" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "createdAt" INTEGER,
  "updatedAt" INTEGER
);

-- Rate limiting storage: "database" (convention from eccos auth-baseline config).
CREATE TABLE IF NOT EXISTS "rateLimit" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "lastRequest" INTEGER NOT NULL
);
