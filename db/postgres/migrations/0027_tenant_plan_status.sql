-- ─────────────────────────────────────────────────────────────────────────────
-- 0027 · tenant_plan_status
--
-- P6-10: the durable record of each tenant's own plan-limit evaluation
-- — written periodically by apps/api's plan-usage-sweep.ts (mirroring
-- P6-07's weekly-report-scheduler.ts own hourly setInterval
-- convention), read by weekly-report-scheduler.ts to decide whether a
-- hard-exceeded tenant's weekly report email should be paused (see
-- that file's own doc comment for why email delivery, specifically,
-- is this MVP's chosen degradation point — not ingestion or
-- investigation, which live in services not this one touches).
--
-- `soft_notified_at` is what keeps a tenant that stays soft-exceeded
-- for days from getting the same "you're approaching your limit"
-- email every single sweep — notified once per crossing, not once per
-- evaluation.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE tenant_plan_status (
  tenant_id            UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  seats_status         TEXT NOT NULL DEFAULT 'ok' CHECK (seats_status IN ('ok', 'soft_exceeded', 'hard_exceeded')),
  event_volume_status  TEXT NOT NULL DEFAULT 'ok' CHECK (event_volume_status IN ('ok', 'soft_exceeded', 'hard_exceeded')),
  cost_status          TEXT NOT NULL DEFAULT 'ok' CHECK (cost_status IN ('ok', 'soft_exceeded', 'hard_exceeded')),
  evaluated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  soft_notified_at     TIMESTAMPTZ
);

ALTER TABLE tenant_plan_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_plan_status FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_plan_status
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON tenant_plan_status TO sentinel_app;

COMMIT;
