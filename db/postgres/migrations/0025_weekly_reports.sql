-- ─────────────────────────────────────────────────────────────────────────────
-- 0025 · weekly_reports / tenant_report_schedule
--
-- P6-07: the brief's one-page weekly owner summary. `weekly_reports` is
-- the persisted report itself (fixed window, same reasoning as
-- 0024_scan_jobs.sql's own — a report an owner forwards or re-opens
-- later must look the same, not silently recompute). `headline` and
-- `one_improvement` are stored as their own columns (not just buried
-- in `data`) because AC2's own claim — "names EXACTLY ONE improvement,
-- not a list" — needs to be something a reviewer or a future audit can
-- check directly, not something that has to be excavated from a jsonb
-- blob and trusted to have been shaped correctly at write time.
--
-- `tenant_report_schedule` is the "configurable schedule" AC — one row
-- per tenant, defaulted on first read rather than requiring a row to
-- already exist (see ReportScheduleRepository's own doc comment).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE weekly_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  window_start     TIMESTAMPTZ NOT NULL,
  window_end       TIMESTAMPTZ NOT NULL,
  headline         TEXT NOT NULL,
  one_improvement  TEXT,
  is_quiet         BOOLEAN NOT NULL DEFAULT false,
  data             JSONB NOT NULL,
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  emailed_at       TIMESTAMPTZ
);

CREATE INDEX weekly_reports_tenant_generated_idx ON weekly_reports (tenant_id, generated_at DESC);

ALTER TABLE weekly_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON weekly_reports
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON weekly_reports TO sentinel_app;

CREATE TABLE tenant_report_schedule (
  tenant_id     UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- 0 = Sunday ... 6 = Saturday (JS Date.getUTCDay() convention, since
  -- the scheduler that reads this is Node, not Postgres).
  day_of_week   SMALLINT NOT NULL DEFAULT 1 CHECK (day_of_week BETWEEN 0 AND 6),
  enabled       BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenant_report_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_report_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_report_schedule
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON tenant_report_schedule TO sentinel_app;

COMMIT;
