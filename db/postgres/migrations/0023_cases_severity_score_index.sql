-- ─────────────────────────────────────────────────────────────────────────────
-- 0023 · cases ranked by severity then score, indexed
--
-- P6-02: the case list is "ranked by severity and score," at up to 10,000
-- cases per the ticket's own performance AC. `severity` is a plain text
-- column (0001_foundation.sql), not a Postgres ENUM, so its own alphabetical
-- order ("critical" < "high" < "info" < "low" < "medium") does not match the
-- real severity ranking the product uses everywhere else (critical=4 ...
-- info=0, @sentinel/design-tokens' own `severity.*.rank`). Sorting by that
-- rank with no supporting index would force a sequential scan + sort on
-- every request at this ticket's own stated scale. This expression index
-- mirrors the rank mapping the application already uses, so a query that
-- ORDERs BY the identical CASE expression can use it.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE INDEX cases_tenant_severity_rank_score_idx ON cases (
  tenant_id,
  (CASE severity
    WHEN 'critical' THEN 4
    WHEN 'high' THEN 3
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 1
    ELSE 0
  END) DESC,
  score DESC
);

COMMIT;
