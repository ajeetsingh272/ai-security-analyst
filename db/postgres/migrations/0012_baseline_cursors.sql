-- ─────────────────────────────────────────────────────────────────────────────
-- 0012 · baseline_cursors (P3-05)
--
-- The watermark for incremental entity-baseline recomputation (AC5): "events
-- up to this timestamp have already been folded into sentinel.entity_baselines
-- for this tenant" — one row per tenant, not per metric, since all 5 baseline
-- metrics (country/asn/device/sign_in_hour/data_volume) are computed from the
-- same underlying sentinel.events scan in one pass.
--
-- This mirrors connector_cursors' own role (0001_foundation.sql) — a small,
-- durable watermark in Postgres governing what has already been folded out of
-- a larger external store — except the larger store here is ClickHouse, not a
-- third-party vendor API. A rare crash between the ClickHouse insert and this
-- cursor's own commit can double-count one batch of events into that batch's
-- buckets (see services/correlate/internal/baseline's own doc comment) — an
-- accepted, documented tradeoff for a behavioural baseline, not a ledger.
--
-- Rollback: restore from backup, or on an empty database, drop the schema
-- and re-migrate.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE baseline_cursors (
  tenant_id         UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  last_processed_at TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE baseline_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE baseline_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON baseline_cursors
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON baseline_cursors TO sentinel_app;
GRANT SELECT ON baseline_cursors TO sentinel_jobs;

COMMIT;
