-- ─────────────────────────────────────────────────────────────────────────────
-- 0013 · cases.escalated_at (P4-01)
--
-- The one thing missing before an AI analyst can consume anything: nothing
-- in this system ever published a case to the `cases` Kafka topic — only
-- ever written one to Postgres (P3-02 onward). services/correlate now
-- publishes once a case's score first crosses its tenant's own escalation
-- threshold (scoring.EscalationThreshold); this column is what makes that
-- "first" durable and idempotent.
--
-- `escalated_at IS NULL` is the "not yet published" marker a fast-path
-- publish attempt (right after scoring.Recompute, inside
-- AddSignalToCase/CreateCaseWithSignal's own transaction) checks before
-- trying, and the ONLY thing CloseQuietCases' own periodic sweep needs to
-- find and retry any case whose fast-path publish failed or was never
-- attempted (a Kafka producer error, a process restart mid-flight) — no
-- separate outbox table, since this one nullable timestamp already
-- captures "needs publishing" (NULL) vs "already published" (set) exactly.
--
-- Rollback: restore from backup, or on an empty database, drop the schema
-- and re-migrate.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE cases ADD COLUMN escalated_at TIMESTAMPTZ;

COMMIT;
