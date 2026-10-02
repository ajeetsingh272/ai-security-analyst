-- ─────────────────────────────────────────────────────────────────────────────
-- 0001 · Foundation: tenancy, isolation, audit
--
-- Implements ADR-0008 (row-level security isolation) and the audit half of
-- ADR-0007 (hash-chained append-only log).
--
-- The threat this schema defends against is not an attacker at the perimeter.
-- It is a developer writing `SELECT * FROM cases WHERE id = $1` and forgetting
-- `AND tenant_id = $2`. That bug will be written. RLS makes it return zero rows
-- instead of another customer's data.
--
-- Rollback: drop the schema. This migration is additive from empty; there is no
-- partial-rollback path, and the recovery procedure is restore-from-backup.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- citext: email comparison must be case-insensitive. "Priya@x.com" and
-- "priya@x.com" are one person, and treating them as two is an auth bug.
CREATE EXTENSION IF NOT EXISTS "citext";

-- ── Roles ───────────────────────────────────────────────────────────────────
-- The application role deliberately lacks BYPASSRLS. A role that can bypass
-- isolation defeats the entire mechanism, so this is not a configuration
-- preference — it is the control.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_app') THEN
    CREATE ROLE sentinel_app NOLOGIN NOBYPASSRLS;
  END IF;
  -- Separate role for background jobs that legitimately span tenants.
  -- Every use is audited; it is an exception, never the default path.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_jobs') THEN
    CREATE ROLE sentinel_jobs NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- ── Tenancy ─────────────────────────────────────────────────────────────────

CREATE TABLE tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  plan          TEXT NOT NULL CHECK (plan IN ('msp', 'startup', 'small_business', 'trial')),
  -- Sharding indirection exists from day one (ADR-0003) so the Phase 7
  -- hot-tenant split is a configuration change, not a migration.
  shard_count   SMALLINT NOT NULL DEFAULT 1 CHECK (shard_count BETWEEN 1 AND 64),
  eps_quota     INTEGER NOT NULL DEFAULT 500,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'degraded', 'churned')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'analyst', 'read_only')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

-- An MSP's access to a client tenant. Scoped, explicit, revocable — never
-- implied by role alone.
CREATE TABLE msp_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  msp_tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  UNIQUE (msp_tenant_id, client_tenant_id),
  CHECK (msp_tenant_id <> client_tenant_id)
);

-- ── Connectors ──────────────────────────────────────────────────────────────

CREATE TABLE connectors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('m365', 'google_workspace', 'aws', 'azure', 'syslog')),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'healthy', 'degraded', 'revoked', 'error')),
  -- Envelope-encrypted with a per-tenant DEK wrapped by a KMS KEK. A database
  -- dump without KMS access yields nothing usable.
  credentials   BYTEA,
  dek_id        TEXT,
  last_error    TEXT,
  last_sync_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind)
);

-- Cursors commit only after the batch is durably acknowledged by Kafka, which
-- is what makes at-least-once delivery hold (ADR-0002).
CREATE TABLE connector_cursors (
  connector_id  UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  stream        TEXT NOT NULL,
  cursor        JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, stream)
);

-- ── Cases ───────────────────────────────────────────────────────────────────

CREATE TABLE cases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  severity      TEXT CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  score         NUMERIC(6, 2),
  score_components JSONB,
  title         TEXT,
  window_start  TIMESTAMPTZ NOT NULL,
  window_end    TIMESTAMPTZ,
  entity_ids    TEXT[] NOT NULL DEFAULT '{}',
  signal_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cases_tenant_created_idx ON cases (tenant_id, created_at DESC);
CREATE INDEX cases_entities_idx ON cases USING GIN (entity_ids);

-- State is DERIVED from this append-only log, never stored destructively, so a
-- case's full history is always reconstructible. Required by the audit guarantee.
CREATE TABLE case_transitions (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id       UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  from_state    TEXT,
  to_state      TEXT NOT NULL CHECK (to_state IN (
                  'open', 'triaging', 'investigating', 'awaiting_approval',
                  'actioned', 'closed', 'dismissed')),
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('human', 'ai', 'system')),
  actor_id      TEXT NOT NULL,
  reason        TEXT NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX case_transitions_case_idx ON case_transitions (case_id, id);

-- ── Actions & approvals ─────────────────────────────────────────────────────

CREATE TABLE actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id       UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  playbook      TEXT NOT NULL,
  target        JSONB NOT NULL,
  blast_radius  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed', 'approved', 'executing', 'succeeded', 'failed', 'reversed')),
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at   TIMESTAMPTZ
);

-- The nonce is burned here on first use. Redis is the fast path; this unique
-- constraint is the correctness guarantee when Redis is unavailable (ADR-0007).
CREATE TABLE approval_nonces (
  nonce         TEXT PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_id     UUID NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  used_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Audit: append-only, hash-chained ────────────────────────────────────────
--
-- Tamper-evidence is a property of the schema and the grants, not of a
-- convention anyone has to remember. In an incident our own operators may be
-- the subject of the inquiry, so "trust our access controls" is strictly weaker
-- than "the chain verifies".

CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('human', 'ai', 'system', 'connector')),
  actor_id      TEXT NOT NULL,
  action        TEXT NOT NULL,
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  prev_hash     BYTEA NOT NULL,
  entry_hash    BYTEA NOT NULL
);

CREATE INDEX audit_tenant_time_idx ON audit_log (tenant_id, occurred_at DESC);

-- Belt and braces: the grants below remove UPDATE/DELETE, and this trigger
-- makes any attempt that slips through a loud error rather than silent data loss.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % attempted on entry %', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ── Row-level security ──────────────────────────────────────────────────────
--
-- FORCE is what makes this hold for the table owner too. Without it, the owner
-- silently bypasses every policy below.

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships', 'connectors', 'cases', 'case_transitions',
    'actions', 'approval_nonces', 'audit_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t);
  END LOOP;
END
$$;

-- connector_cursors is tenant-scoped transitively through its connector.
ALTER TABLE connector_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connector_cursors USING (
  connector_id IN (
    SELECT id FROM connectors WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
  )
);

-- ── Grants ──────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sentinel_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sentinel_app;

-- The audit log is the exception: insert and read only. No UPDATE. No DELETE.
REVOKE UPDATE, DELETE ON audit_log FROM sentinel_app;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO sentinel_jobs;

COMMIT;
