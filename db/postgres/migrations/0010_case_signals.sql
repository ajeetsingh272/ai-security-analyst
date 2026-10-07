-- ─────────────────────────────────────────────────────────────────────────────
-- 0010 · case_signals
--
-- P3-02: the join table clustering actually needs. cases/case_transitions
-- (0001_foundation.sql) already have the right shape for this ticket
-- (window_start/window_end, entity_ids, signal_count) and are deliberately
-- left untouched here — P3-03 ("Case lifecycle and append-only transition
-- log") owns any further schema evolution of those two tables, not this one.
--
-- What was missing: nothing links an individual SIGNAL to the case it
-- joined. cases.signal_count is only ever a count, and entity_ids only
-- names which entities a case is about — neither tells you WHICH signals
-- are in a case, which AC3 ("a late-arriving signal joins an open case
-- rather than creating a duplicate") and AC5/T4 ("clustering is
-- deterministic — identical input produces an identical case set") both
-- need: T4 specifically means replaying the IDENTICAL signal stream twice
-- must produce the identical result, which requires recognising "this
-- exact signal is already in a case" rather than re-deciding from scratch.
--
-- UNIQUE (tenant_id, dedupe_key) is what makes that idempotent: inserting
-- the SAME signal (same go/sentinelsignal.Signal.DedupeKey) twice is a
-- no-op (ON CONFLICT DO NOTHING in the application code), not a second
-- row — ADR-0004-style "replay always converges", here applied to
-- correlation instead of the detection engine's own commit-after-ack.
--
-- detected_at is the signal's own event time (Signal.DetectedAt), never
-- wall-clock processing time — AC5's determinism depends on every
-- windowing decision being made from data in the signal itself, not from
-- whenever a consumer happened to process it.
--
-- Rollback: restore from backup, or on an empty database, drop the schema
-- and re-migrate.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE case_signals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id     UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  dedupe_key  TEXT NOT NULL,
  signal_id   TEXT NOT NULL,
  rule_id     TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  severity    TEXT NOT NULL,
  event_ids   TEXT[] NOT NULL DEFAULT '{}',
  detected_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);

CREATE INDEX idx_case_signals_case ON case_signals (case_id);
-- The clustering hot-path query: "is there an open case for this
-- (tenant, entity) whose most recent signal is still within the sliding
-- window?" — this index is what keeps that a single indexed lookup.
CREATE INDEX idx_case_signals_tenant_entity_detected ON case_signals (tenant_id, entity_type, entity_id, detected_at DESC);

ALTER TABLE case_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_signals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON case_signals
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON case_signals TO sentinel_app;
GRANT SELECT ON case_signals TO sentinel_jobs;

COMMIT;
