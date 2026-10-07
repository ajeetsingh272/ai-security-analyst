-- ─────────────────────────────────────────────────────────────────────────────
-- 0009 · entities / entity_aliases / entity_merges
--
-- P3-01 (ADR-0011): the correlation plane's own entity/alias graph. A signal's
-- raw identifiers (a UPN, an Azure AD object id, a primary or proxy email
-- address) resolve to one canonical entity, so signals naming the same real
-- person in different formats correlate as one, not several.
--
-- Fully tenant-scoped (unlike P2-12's hotfix_rules, which is deliberately
-- global) — identical identifiers in two different tenants must never merge
-- (AC2/T2), so every table here carries tenant_id and full RLS, mirroring
-- P2-10's suppressions table shape.
--
-- entities: one row per canonical entity. status is 'provisional' for a
-- stub created with no alias at all (AC3 — "unresolvable entities are
-- retained... rather than discarded") and 'resolved' once at least one
-- alias is attached. Never deleted — an entity id must stay stable for
-- every signal/case that already references it.
--
-- entity_aliases: one row per (tenant, alias_type, alias_value), pointing at
-- whichever entity currently owns it. The UNIQUE constraint IS the lookup
-- index (Postgres creates one implicitly) — resolution latency (AC4, under
-- 5ms p99) depends on this being a single indexed point-query regardless of
-- table size.
--
-- entity_merges: ADR-0011's own decision — a dedicated, append-only audit
-- trail for merge/reversal (AC5), not a Go port of packages/db's
-- TypeScript hash chain (that chain has never been written to from Go; see
-- the ADR for why porting it was rejected for this ticket). moved_alias_ids
-- snapshots exactly which entity_aliases rows this merge moved, taken
-- inside the same transaction as the move, so reversal is exact — it undoes
-- precisely this merge, never "every alias currently on the target entity"
-- (which could include a later, unrelated merge someone else performed).
--
-- Rollback: restore from backup, or on an empty database, drop the schema
-- and re-migrate.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE entities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL, -- 'user' | 'host' | 'ip' | 'session' | 'mailbox' — free-form, matching
                              -- the windowed engine's own entityTypeFromGroupField convention
                              -- (services/detect/internal/windowed/scheduler.go), not an enum.
  status      TEXT NOT NULL DEFAULT 'provisional' CHECK (status IN ('provisional', 'resolved')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_entities_tenant_type ON entities (tenant_id, entity_type);

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON entities
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON entities TO sentinel_app;
GRANT SELECT ON entities TO sentinel_jobs;

CREATE TABLE entity_aliases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_id   UUID NOT NULL REFERENCES entities(id),
  alias_type  TEXT NOT NULL, -- 'upn' | 'object_id' | 'email' | 'proxy_address' | 'unknown'
  alias_value TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, alias_type, alias_value)
);

CREATE INDEX idx_entity_aliases_entity ON entity_aliases (entity_id);

ALTER TABLE entity_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON entity_aliases
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_aliases TO sentinel_app;
GRANT SELECT ON entity_aliases TO sentinel_jobs;

CREATE TABLE entity_merges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_entity_id  UUID NOT NULL REFERENCES entities(id),
  into_entity_id  UUID NOT NULL REFERENCES entities(id),
  moved_alias_ids UUID[] NOT NULL,
  reason          TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('human', 'system')),
  actor_id        TEXT NOT NULL,
  merged_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_at     TIMESTAMPTZ,
  reversed_by     TEXT
);

CREATE INDEX idx_entity_merges_tenant ON entity_merges (tenant_id);

ALTER TABLE entity_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_merges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON entity_merges
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_merges TO sentinel_app;
GRANT SELECT ON entity_merges TO sentinel_jobs;

COMMIT;
