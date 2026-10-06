-- ─────────────────────────────────────────────────────────────────────────────
-- 0008 · hotfix_rules
--
-- P2-12 — ADR-0004's own named escape hatch: "a small interpreted 'hotfix
-- rule' path for urgent detections exists for emergencies, capped at 10
-- active rules and expiring automatically after 7 days, forcing proper
-- compilation." Deliberately constrained so it cannot become the normal
-- way rules are added (ADR-0004's own "Alternatives considered: runtime
-- YAML interpretation" already rejected that as the general path).
--
-- NOT tenant-scoped, deliberately — no tenant_id column, no RLS. The
-- cap is "10 active rules platform-wide" (a single global count across
-- every tenant combined), not per-tenant, so this table uses the same
-- shape tenants/users themselves already use (0001_foundation.sql): a
-- global table, globally readable/writable by sentinel_app via the
-- blanket grant below, with no per-row tenant isolation to enforce.
--
-- expires_at is forced by a trigger, not left to a plain default —
-- AC2's "expires automatically after 7 days with no option to extend
-- in place" is a SCHEMA-level guarantee this way: no INSERT or UPDATE
-- can make it anything other than created_at + 7 days, because the
-- trigger below overwrites whatever value was supplied, every time.
-- (A GENERATED ALWAYS column was tried first and rejected directly by
-- Postgres — "generation expression is not immutable", since timestamptz
-- + interval is STABLE, not IMMUTABLE, regardless of the interval being
-- a fixed number of days — so a trigger is the mechanism that actually
-- works here, not a style preference.) This also gives the integration
-- test for "a hotfix rule stops evaluating after 7 days" a clean way to
-- simulate age without waiting 7 real days: inserting a fixture with a
-- backdated created_at makes the trigger-derived expires_at land in the
-- past automatically, through the exact same computation a real 7-day-
-- old row went through.
--
-- The max-10-active cap is enforced in application code (count-then-
-- insert inside one transaction, serialized by pg_advisory_xact_lock —
-- the same mechanism packages/db's AuditLogWriter already uses to
-- serialize its own hash chain), not here: CHECKing "fewer than 10
-- other rows satisfy some condition" against sibling rows is not a
-- single-row CHECK constraint Postgres can express directly.
--
-- revoked_at/revoked_by allow early manual revocation (stopping a hotfix
-- rule sooner than its own 7-day expiry) — a different operation from
-- "extending it", which AC2 forbids outright and this schema makes
-- impossible.
--
-- Rollback: restore from backup, or on an empty database, drop the schema
-- and re-migrate.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE hotfix_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- rule_id/rule_title are extracted from rule_yaml at write time, kept
  -- as their own columns purely for display (the operations dashboard
  -- listing, AC4) without needing to parse YAML just to show a title.
  -- services/detect's own sigmac.Parse is the AUTHORITATIVE parse of
  -- rule_yaml — a row whose YAML fails that parse, or declares a
  -- windowed Aggregation (out of scope for this "small" interpreted
  -- path), is simply never loaded into the running evaluator, logged
  -- as a startup-time warning rather than rejected at write time by a
  -- second, duplicate Sigma parser in TypeScript.
  rule_id     TEXT NOT NULL,
  rule_title  TEXT NOT NULL,
  rule_yaml   TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT now(), -- overwritten by the trigger below on every INSERT/UPDATE
  revoked_at  TIMESTAMPTZ,
  revoked_by  UUID REFERENCES users(id)
);

CREATE OR REPLACE FUNCTION hotfix_rules_force_expiry() RETURNS trigger AS $$
BEGIN
  NEW.expires_at := NEW.created_at + interval '7 days';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hotfix_rules_force_expiry_trigger
  BEFORE INSERT OR UPDATE ON hotfix_rules
  FOR EACH ROW EXECUTE FUNCTION hotfix_rules_force_expiry();

CREATE INDEX idx_hotfix_rules_active ON hotfix_rules (expires_at) WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON hotfix_rules TO sentinel_app;
GRANT SELECT ON hotfix_rules TO sentinel_jobs;

COMMIT;
