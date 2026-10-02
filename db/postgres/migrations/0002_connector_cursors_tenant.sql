-- ─────────────────────────────────────────────────────────────────────────────
-- 0002 · connector_cursors carries its own tenant_id
--
-- 0001 scoped this table transitively: its policy resolved the tenant through a
-- subquery against connectors. That is correct but weaker than the rest of the
-- schema in two ways worth closing before anything is built on it.
--
-- First, the invariant "every tenant-scoped table carries a non-null tenant_id"
-- is the property a CI check can enumerate (P0-05). One table scoped a different
-- way is one table a checker has to special-case, and special cases are where
-- isolation bugs live.
--
-- Second, a subquery policy is evaluated per row. On the hot cursor-commit path
-- that is a cost paid forever to avoid storing 16 bytes.
--
-- The composite foreign key is the point of this migration. It makes a cursor
-- whose tenant_id disagrees with its connector's tenant_id unrepresentable —
-- the database refuses the row. Denormalising tenant_id without it would create
-- exactly the drift the column was added to prevent.
--
-- Rollback: restore from backup. The forward path is additive, but the backfill
-- cannot be distinguished from legitimate writes afterwards, so there is no
-- safe automated reverse. On an empty database, drop the schema and re-migrate.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Referencing (id, tenant_id) requires a unique constraint on that pair. id is
-- already the primary key, so this adds no new restriction — it only makes the
-- pair addressable as a foreign-key target.
ALTER TABLE connectors
  ADD CONSTRAINT connectors_id_tenant_key UNIQUE (id, tenant_id);

ALTER TABLE connector_cursors
  ADD COLUMN tenant_id UUID;

-- Backfill before NOT NULL. Empty in practice at this phase; correct regardless.
UPDATE connector_cursors cc
   SET tenant_id = c.tenant_id
  FROM connectors c
 WHERE c.id = cc.connector_id;

ALTER TABLE connector_cursors
  ALTER COLUMN tenant_id SET NOT NULL;

-- The composite FK subsumes the single-column one. Keeping both would give two
-- cascade paths to reason about for no gain.
ALTER TABLE connector_cursors
  DROP CONSTRAINT connector_cursors_connector_id_fkey;

ALTER TABLE connector_cursors
  ADD CONSTRAINT connector_cursors_connector_tenant_fkey
  FOREIGN KEY (connector_id, tenant_id)
  REFERENCES connectors (id, tenant_id) ON DELETE CASCADE;

CREATE INDEX connector_cursors_tenant_idx ON connector_cursors (tenant_id);

-- ── Policy: direct, matching every other tenant-scoped table ────────────────
--
-- USING with no WITH CHECK is deliberate and consistent with 0001: Postgres
-- reuses the USING expression as the insert check, so a write that would land
-- in another tenant is refused by the same expression that hides it on read.

DROP POLICY tenant_isolation ON connector_cursors;

CREATE POLICY tenant_isolation ON connector_cursors
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
