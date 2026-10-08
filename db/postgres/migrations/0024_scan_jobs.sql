-- ─────────────────────────────────────────────────────────────────────────────
-- 0024 · scan_jobs
--
-- P6-05: the free 7-day security scan's own record of "a scan was run,
-- covering this fixed window, for this tenant." Persisted rather than
-- always recomputed live over a sliding "last 7 days" window, because
-- AC3 needs a report an owner can forward and have look the SAME when a
-- colleague opens it tomorrow — a live-recomputed window would silently
-- shift underneath that link.
--
-- Honest disclosure (see the P6-05 PR for the full reasoning): this
-- table does not itself trigger go/sentinelreplay's re-ingestion of 7
-- days of historical activity. That trigger needs a job-orchestration
-- layer (subprocess lifecycle, retries) this ticket does not build, and
-- go/sentinelreplay's own doc comment already names both P6-05 and
-- itself as "neither of which exist yet" at the time it was written. A
-- scan therefore summarises whatever cases already exist for the
-- tenant within the chosen window — accurate for a tenant that has been
-- connected and streaming for a few days, and the exact summarisation
-- logic the eventual real trigger will feed once it exists.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE scan_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('running', 'completed', 'failed')),
  window_start  TIMESTAMPTZ NOT NULL,
  window_end    TIMESTAMPTZ NOT NULL,
  created_by    UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  error         TEXT
);

CREATE INDEX scan_jobs_tenant_created_idx ON scan_jobs (tenant_id, created_at DESC);

ALTER TABLE scan_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scan_jobs
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON scan_jobs TO sentinel_app;

COMMIT;
