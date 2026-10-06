-- ─────────────────────────────────────────────────────────────────────────────
-- 0006 · suppressions
--
-- P2-10 (TG3: "Nothing is hidden — dismissals are surfaced"). Lets an analyst
-- silence a noisy rule (optionally scoped to one entity) for a bounded time,
-- with a mandatory reason, so repeat false positives don't retrain humans to
-- ignore the queue. AC3 ("suppressed signals are still stored and counted,
-- just not escalated") is enforced in application code (services/detect
-- still publishes every signal to the normal `signals` topic regardless of
-- suppression; only the P2-08 critical-alert bypass is skipped) — this table
-- only records WHO decided to suppress WHAT, WHY, and UNTIL WHEN.
--
-- entity_id is nullable: NULL means "every entity for this tenant+rule",
-- which also covers in-stream signals (sentinelsignal.Signal has no
-- EntityID at all today — only windowed signals do).
--
-- reason is NOT NULL with a non-blank CHECK: a suppression with no
-- justification defeats the whole point of TG3. Enforced again at the API
-- layer for a clean 400 rather than a raw constraint-violation error, but
-- kept here too so no insert path (including a future script or console
-- session) can bypass it.
--
-- expires_at is NOT NULL (no permanent suppressions) and must be after
-- created_at — AC4's "expire by default and require explicit renewal".
-- Renewal is modeled as a fresh audit-logged action in application code
-- (apps/api), not as a separate table here.
--
-- revoked_at/revoked_by let an analyst cancel a suppression early without
-- deleting the row — the row itself is the audit trail of "this used to be
-- suppressed", which matters even after it's lifted.
--
-- Rollback: restore from backup, or on an empty database, drop the schema
-- and re-migrate.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE suppressions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id     TEXT NOT NULL,
  entity_id   TEXT,
  reason      TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  revoked_by  UUID REFERENCES users(id),
  CHECK (expires_at > created_at)
);

-- Every live suppression check (services/detect, on the hot path of every
-- evaluated signal) filters on exactly these three columns.
CREATE INDEX idx_suppressions_lookup ON suppressions (tenant_id, rule_id, entity_id);

ALTER TABLE suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppressions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON suppressions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON suppressions TO sentinel_app;
GRANT SELECT ON suppressions TO sentinel_jobs;

COMMIT;
