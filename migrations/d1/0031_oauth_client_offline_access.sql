-- MCP connections now renew themselves: every authorization request carries the
-- offline_access scope, which is what makes the provider issue a refresh token
-- (src/api/better-auth.ts withOfflineAccess). The provider checks a request's
-- scopes against the client's stored list, and clients registered before this
-- change were stored without it, so their next login would fail invalid_scope.
-- Add it to every stored list that lacks it. Data only; nothing else changes.
UPDATE "oauthClient"
SET "scopes" = json_insert("scopes", '$[#]', 'offline_access')
WHERE "scopes" IS NOT NULL
  AND json_valid("scopes")
  AND json_type("scopes") = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each("oauthClient"."scopes") WHERE value = 'offline_access'
  );
