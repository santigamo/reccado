-- 1.7.3 reverted the required issuer column; retain its historical values while
-- allowing new accounts written by 1.7.20. Rebuilding is repeatable and preserves rows.
DROP INDEX IF EXISTS "account_issuer_accountId_idx";
CREATE TABLE IF NOT EXISTS "account_0021" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "issuer" TEXT,
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
INSERT INTO "account_0021" SELECT * FROM "account";
DROP TABLE "account";
ALTER TABLE "account_0021" RENAME TO "account";
