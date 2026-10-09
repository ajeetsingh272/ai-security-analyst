-- ─────────────────────────────────────────────────────────────────────────────
-- 0029 · customer_rules
--
-- P7-10 / ADR-0012: the tenant-self-service counterpart to
-- 0008_hotfix_rules.sql's platform-only escape hatch. Unlike
-- hotfix_rules, this table genuinely IS tenant data (a tenant's own
-- authored detection) — RLS applies here with no exception, the same
-- "tenant_id on every row, no exceptions" ADR-0008 already mandates.
--
-- status lifecycle: pending_validation (just submitted, not yet
-- evaluated against its own fixtures) -> active (passed validation,
-- now evaluated against real events) or rejected (failed validation or
-- its own fixtures, never evaluated) -> suspended_resource_limit
-- (ADR-0012 §2: auto-suspended after repeated runtime-budget
-- violations) or disabled (a tenant admin's own voluntary action).
-- services/detect/internal/customerrules is the ONLY writer that ever
-- sets status to 'active'/'rejected'/'suspended_resource_limit' — it is
-- the authoritative Sigma parser and interpreter (sigmac.Parse/
-- sigmac.Evaluate), never duplicated in TypeScript (apps/api's own
-- extractDisplayFields, mirroring hotfix-rules.ts's identical
-- precedent, is display-only and never gates activation).
--
-- active_rule_count is enforced in application code
-- (count-then-insert inside one transaction, serialized by
-- pg_advisory_xact_lock keyed on the tenant id) for the same reason
-- 0008_hotfix_rules.sql's own cap is: "fewer than N sibling rows
-- satisfy X" is not a single-row CHECK constraint.
--
-- Rollback: restore from backup, or on an empty database, drop the
-- schema and re-migrate.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE customer_rules (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- rule_id/rule_title mirror hotfix_rules' own display-only columns —
  -- extracted at write time, authoritative parse happens only in Go.
  rule_id                    TEXT NOT NULL,
  rule_title                 TEXT NOT NULL,
  rule_yaml                  TEXT NOT NULL,
  positive_fixture           JSONB NOT NULL,
  negative_fixture           JSONB NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'pending_validation'
                               CHECK (status IN ('pending_validation', 'active', 'rejected', 'suspended_resource_limit', 'disabled')),
  rejection_reason           TEXT,
  -- Incremented by the customer-rule worker (ADR-0012 §2) on each
  -- consecutive runtime-budget violation; reset to 0 on any evaluation
  -- that completes within budget. Five consecutive violations
  -- auto-suspends the rule (status -> suspended_resource_limit).
  consecutive_timeout_count INTEGER NOT NULL DEFAULT 0,
  created_by                 UUID NOT NULL REFERENCES users(id),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at               TIMESTAMPTZ,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The customer-rule worker's own per-poll read: "every active rule,
-- grouped by tenant" (ADR-0012 §4/§5's own loader).
CREATE INDEX idx_customer_rules_tenant_status ON customer_rules (tenant_id, status);
-- The activator's own per-poll read: "every rule still awaiting
-- validation, across all tenants" (ADR-0012 §3).
CREATE INDEX idx_customer_rules_pending ON customer_rules (status) WHERE status = 'pending_validation';

ALTER TABLE customer_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_rules
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_rules TO sentinel_app;

COMMIT;
