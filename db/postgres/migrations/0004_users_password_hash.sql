-- ─────────────────────────────────────────────────────────────────────────────
-- 0004 · users.password_hash
--
-- 0001 defined users with no way to authenticate one — (id, email,
-- display_name, created_at) only, no credential column at all. P0-09 is the
-- first ticket that actually signs a user in, which is what surfaces the gap.
--
-- Nullable, not NOT NULL: an OAuth-only user (not yet wired to a real
-- provider — see apps/api/src/auth/ — but the column should not need to
-- change shape when one is) legitimately has no password at all, and NULL
-- means exactly that rather than an empty-string placeholder that an
-- unguarded comparison could accidentally treat as a valid hash.
--
-- Format is `scrypt$N$r$p$saltHex$hashHex` (apps/api/src/auth/password.ts) —
-- enforced in application code, not a CHECK constraint, because the cost
-- parameters are expected to change over time as hardware gets faster, and a
-- CHECK baked to today's format would need its own migration to loosen.
--
-- Rollback: restore from backup, or on an empty database, drop the schema
-- and re-migrate.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE users ADD COLUMN password_hash TEXT;

COMMIT;
