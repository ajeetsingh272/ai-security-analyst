-- ─────────────────────────────────────────────────────────────────────────────
-- 0005 · tenant_deks
--
-- P1-02 (ADR-0008 point 4): "Connector credentials and OAuth refresh tokens
-- are encrypted with a per-tenant DEK, itself wrapped by a KEK in KMS." 0001
-- already added connectors.credentials/dek_id for the ENCRYPTED PAYLOAD, but
-- never added anywhere to store the WRAPPED DEK itself — this is that place.
--
-- One row per tenant (PRIMARY KEY tenant_id, not a separate id column): the
-- guarantee is "per-tenant DEK", not "per-connector" — every connector a
-- tenant onboards (M365, Google Workspace, ...) reuses the same DEK to
-- encrypt its own credentials blob, so a tenant has exactly one row here
-- regardless of how many connectors it later adds.
--
-- kms_key_id identifies which KEK VERSION wrapped this DEK — not which
-- tenant it belongs to (that's the primary key) — so a future KEK rotation
-- can tell an old wrapped_dek apart from a newly-wrapped one without
-- guessing from wrapped_dek's bytes alone.
--
-- Rollback: restore from backup, or on an empty database, drop the schema
-- and re-migrate.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE tenant_deks (
  tenant_id   UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  wrapped_dek BYTEA NOT NULL,
  kms_key_id  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenant_deks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_deks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_deks
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- 0001's `GRANT ... ON ALL TABLES IN SCHEMA public` ran once, against
-- whatever tables existed AT THAT MOMENT — it is not an ongoing rule
-- (that would need ALTER DEFAULT PRIVILEGES instead), so a table created
-- in any LATER migration starts with no grants for sentinel_app/
-- sentinel_jobs at all. Confirmed the hard way: every query against this
-- table failed with "permission denied for table tenant_deks" until
-- these were added. Every future migration that creates a new table
-- needs the same two lines.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_deks TO sentinel_app;
GRANT SELECT ON tenant_deks TO sentinel_jobs;

COMMIT;
