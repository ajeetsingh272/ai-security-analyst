-- ─────────────────────────────────────────────────────────────────────────────
-- P3-04's own "typical data-transfer volumes" baseline dimension needs a
-- numeric aggregate, not a categorical one — entity_baselines' existing
-- columns (observations/distinct_values/value_counts) model "usual VALUES"
-- (a country, a device), not "usual MAGNITUDE" (how many bytes is normal for
-- this entity). quantilesTDigest is used instead of mean/stddev because real
-- data-transfer volume is skewed, not normally distributed — a few outliers
-- would otherwise drag the "typical" range far from what's actually usual.
--
-- `ADD COLUMN IF NOT EXISTS` because db/clickhouse/*.sql files are replayed
-- on every `pnpm db:migrate` (see 0003's own comment) — this must be a no-op
-- the second time.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE sentinel.entity_baselines
    ADD COLUMN IF NOT EXISTS volume_quantiles AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), Float64) AFTER value_counts;
