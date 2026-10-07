-- ─────────────────────────────────────────────────────────────────────────────
-- 0014 · cases.escalated_published_at (P4-01)
--
-- 0013's own escalated_at conflated two different facts into one column:
-- "this case's score crossed the threshold" (a fact about SCORING, decided
-- exactly once, inside the same transaction scoring.Recompute runs in) and
-- "this case's escalation was successfully PUBLISHED to Kafka" (a fact about
-- a network call that happens, necessarily, after that transaction commits
-- and can fail independently of it).
--
-- Marking escalated_at the moment it is decided, and then having the
-- catch-up sweep in CloseQuietCases look for "escalated_at IS NULL" to find
-- cases needing a retry, meant a publish that failed on the FIRST (fast-path)
-- attempt could never be retried at all — escalated_at was already set by
-- the time the failure was known, so the catch-up query would never see it
-- again. Caught directly: a dedicated test simulating exactly this failure
-- mode (TestPostgresStore_CloseQuietCasesRetriesAFailedPublish) failed
-- before this migration existed.
--
-- escalated_at now means only "decided, exactly once" (unchanged shape,
-- unchanged meaning otherwise). escalated_published_at means "confirmed
-- delivered" — set only after a successful publish, which is what the
-- catch-up sweep now actually looks for:
-- escalated_at IS NOT NULL AND escalated_published_at IS NULL.
--
-- Rollback: restore from backup, or on an empty database, drop the schema
-- and re-migrate.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE cases ADD COLUMN escalated_published_at TIMESTAMPTZ;

COMMIT;
