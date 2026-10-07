-- ─────────────────────────────────────────────────────────────────────────────
-- 0007 · suppressions.suppressed_count
--
-- P2-10 AC5: "The dashboard shows active suppressions and what they have
-- suppressed." `signals` has no consumer persisting it anywhere queryable
-- yet (sentinel.signals in ClickHouse, db/clickhouse/0001_events.sql,
-- exists but nothing writes to it — that's the correlation plane's own
-- future job, P3), so a per-row running count, incremented atomically by
-- services/detect's own suppression check every time it actually matches
-- (services/detect/internal/suppression.PostgresChecker.IsSuppressed), is
-- this ticket's own honest answer to "what" within today's real
-- architecture: how many signals this suppression has silenced so far.
--
-- A separate migration from 0006, not an edit to it — 0006 was already
-- applied locally while this ticket was in progress, and migrations are
-- immutable once applied (scripts/migrate.sh's own ledger enforces this).
--
-- Rollback: restore from backup, or on an empty database, drop the schema
-- and re-migrate.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS suppressed_count INTEGER NOT NULL DEFAULT 0;

COMMIT;
