-- ─────────────────────────────────────────────────────────────────────────────
-- 0011 · case scoring (P3-04)
--
-- Two additive changes, nothing touched in cases/case_transitions/
-- case_signals' own existing columns:
--
-- 1. case_signals.mitre_ids — AC1/AC2's own "MITRE kill-chain progression"
--    scoring component needs to know every ATT&CK tactic a case's signals
--    span, which means knowing every signal's own technique IDs
--    (go/sentinelsignal.Signal.MitreIDs, already on the wire since P2-xx's
--    rule corpus work) — case_signals never stored them before this ticket,
--    so a case's own kill-chain shape was unrecoverable after the fact.
--
-- 2. entity_criticality — AC2's "a case touching a flagged high-value
--    identity scores above an equivalent case on an ordinary one" needs
--    somewhere to record that flag. This is deliberately keyed by the same
--    raw (tenant_id, entity_type, entity_id) pair cases.entity_ids and
--    case_signals already use — NOT by services/correlate/internal/
--    entity's own resolved entity UUID. P3-02's own doc comment already
--    named why clustering stays on the raw identifier rather than the
--    entity-resolution graph ("unifying different raw formats... is real,
--    separate integration work"); this ticket inherits that same boundary
--    rather than solving it. Nothing yet sets a row's criticality to
--    'high' through an API — this ticket only adds the flag and the
--    scoring behaviour that reads it; populating it is future, separate
--    work (an admin surface, or a connector-sourced VIP list).
--
-- Rollback: restore from backup, or on an empty database, drop the schema
-- and re-migrate.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE case_signals ADD COLUMN mitre_ids TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE entity_criticality (
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  criticality  TEXT NOT NULL CHECK (criticality IN ('normal', 'high')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entity_type, entity_id)
);

ALTER TABLE entity_criticality ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_criticality FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON entity_criticality
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_criticality TO sentinel_app;
GRANT SELECT ON entity_criticality TO sentinel_jobs;

COMMIT;
