-- ─────────────────────────────────────────────────────────────────────────────
-- 0016 · analyst_degraded_queue
--
-- P4-10 AC3: "cases are queued for re-investigation once the provider
-- recovers." A case the analyst degraded to a rule-only alert because
-- the circuit breaker was open (P4-09's own degradeToRuleOnlyAlert path,
-- now reused for a THIRD reason alongside grounding failure and a cost
-- hard cap) still deserves a real AI investigation once the provider is
-- back — this table is what remembers which cases are still owed one.
--
-- UNIQUE (tenant_id, case_id) makes enqueueing idempotent: the same
-- case degrading twice while the circuit stays open must not queue it
-- twice, which would otherwise re-investigate it twice on recovery and
-- risk a second, redundant AI report landing after the first.
--
-- processed_at NULL means "still owed a re-investigation"; set once the
-- recovery drain has re-published this case's event back onto the
-- cases topic — not once the re-investigation itself completes, since
-- re-publishing is this table's own job and the ordinary pipeline
-- (worker.ts, already tested elsewhere) owns everything after that.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE analyst_degraded_queue (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id      UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL,
  queued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, case_id)
);

CREATE INDEX idx_analyst_degraded_queue_pending ON analyst_degraded_queue (tenant_id, queued_at) WHERE processed_at IS NULL;

ALTER TABLE analyst_degraded_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyst_degraded_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON analyst_degraded_queue
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON analyst_degraded_queue TO sentinel_app;
GRANT SELECT ON analyst_degraded_queue TO sentinel_jobs;

COMMIT;
