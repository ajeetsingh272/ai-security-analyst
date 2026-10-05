-- ─────────────────────────────────────────────────────────────────────────────
-- 0003 · Row-level security on msp_links
--
-- Flagged and deliberately deferred in 0001/0002's own commentary: msp_links
-- relates two tenants, so it does not fit the single-tenant_id RLS pattern
-- every other tenant-scoped table uses, and was classified as GLOBAL (no
-- policy at all) rather than solved properly. That was fine while nothing
-- read this table for access control. P0-09 is the first thing that does —
-- "the MSP role grants scoped access to explicitly linked client tenants and
-- nothing else" means msp_links IS the access-control data, and leaving it
-- world-readable to every authenticated connection, regardless of tenant
-- context, is the gap this closes.
--
-- A row is visible to EITHER side of the relationship: the MSP tenant (who
-- needs to know which clients they manage) and the client tenant (who needs
-- to know which MSP manages them, so they can audit or revoke it from their
-- own side). Both are legitimate parties to a grant they are named in.
--
-- Rollback: restore from backup, or on an empty database, drop the schema
-- and re-migrate — same policy as every other migration in this directory.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE msp_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE msp_links FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON msp_links
  USING (
    msp_tenant_id = current_setting('app.tenant_id', true)::uuid
    OR client_tenant_id = current_setting('app.tenant_id', true)::uuid
  );

COMMIT;
