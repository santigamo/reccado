-- 0019_two_factor.sql
-- The twoFactor plugin (better-auth 1.7.2): TOTP as a second factor after a
-- password sign-in, so logging in is a password manager's autofill instead of a
-- wait for mail. Email OTP stays installed, demoted to what it is good at --
-- rescue, and the ladder that bootstraps the password in the first place.
--
-- Fields transcribed from the plugin's own schema.ts rather than guessed. 0017
-- is why: its foreign keys were inferred from table names and pointed at
-- synthetic ids the plugin never writes, which D1 only rejected at runtime.
-- Here `userId` references user(id), which is that table's primary key, and it
-- is the only reference the plugin declares.
--
-- Booleans and dates are INTEGER, matching 0016: better-auth's SQLite dialect
-- writes 0/1 and epoch milliseconds.
--
-- Inert to running code until the deploy that enables the plugin.

CREATE TABLE IF NOT EXISTS "twoFactor" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "secret" TEXT NOT NULL,
  "backupCodes" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id"),
  "verified" INTEGER DEFAULT 1,
  "failedVerificationCount" INTEGER DEFAULT 0,
  "lockedUntil" INTEGER
);

CREATE INDEX IF NOT EXISTS "twoFactor_secret_idx" ON "twoFactor"("secret");
CREATE INDEX IF NOT EXISTS "twoFactor_userId_idx" ON "twoFactor"("userId");

-- The plugin flips this on the user row when enrolment is verified, and reads it
-- on sign-in to decide whether a second factor is owed.
ALTER TABLE "user" ADD COLUMN "twoFactorEnabled" INTEGER;
