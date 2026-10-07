-- ─────────────────────────────────────────────────────────────────────────────
-- 0015 · llm_usage
--
-- P4-06: "token spend is tracked per tenant per day against a plan
-- allowance." One row per Anthropic call (triage or investigation),
-- not a pre-aggregated daily rollup — the daily figure a budget check
-- needs is a cheap SUM(...) GROUP BY day over a single tenant's own
-- rows (RLS already scopes every query to one tenant, and a tenant's
-- own daily call volume is small), and keeping the raw per-call rows
-- means T1 ("token accounting matches the provider's reported usage")
-- can be checked against an actual row, not a derived number that lost
-- its own provenance.
--
-- cost_usd is computed and stored at record time, from whatever price
-- table was configured THEN — re-pricing historical rows if the price
-- table changes later is a deliberate non-goal: a tenant's past bill
-- must never retroactively change because an operator updated a price
-- file.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE llm_usage (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id               UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  model                 TEXT NOT NULL,
  stage                 TEXT NOT NULL CHECK (stage IN ('triage', 'investigation')),
  input_tokens          INTEGER NOT NULL,
  output_tokens         INTEGER NOT NULL,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd              NUMERIC(10, 6) NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The budget check's own hot-path query: "this tenant's total cost
-- since the start of today."
CREATE INDEX idx_llm_usage_tenant_recorded ON llm_usage (tenant_id, recorded_at);

ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON llm_usage
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON llm_usage TO sentinel_app;
GRANT SELECT ON llm_usage TO sentinel_jobs;

COMMIT;
