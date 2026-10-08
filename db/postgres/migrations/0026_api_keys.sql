-- ─────────────────────────────────────────────────────────────────────────────
-- 0026 · api_keys
--
-- P6-09: the public API's own auth mechanism, separate from the
-- cookie-based dashboard session (P0-09). Only `key_hash` is ever
-- stored — the raw secret is shown to the creator exactly once, at
-- creation, and is not recoverable afterward (same principle as a
-- password hash, though SHA-256 rather than a slow KDF is the correct
-- choice here: the input is already a high-entropy random secret, not
-- a human-chosen password an attacker could dictionary-guess).
-- `key_prefix` is stored in the clear purely so a tenant can tell two
-- keys apart in a list without ever re-displaying the secret itself.
--
-- `scopes` is the "configurable permissions" AC — deliberately just
-- {read, write} rather than a larger matrix: nothing else in this
-- schema has a finer-grained permission model to mirror (the
-- dashboard's own Role enum is also a simple ascending scale, not a
-- matrix), and a key's scopes are mapped onto that same Role scale at
-- auth time (see apps/api/src/auth/api-key-plugin.ts).
--
-- No tenant-scoped role (sentinel_app) can look up a key by hash
-- directly — by design, nothing is known about which tenant a raw key
-- belongs to until AFTER that lookup resolves it, so the lookup itself
-- must run before any tenant context exists. It is still safe: the
-- pool's own default connection role bypasses this table's RLS (the
-- same precedent the weekly-report scheduler's own
-- `listTenantsDueForWeeklyReport` and `listTenantsWithPendingDegraded
-- Cases` already established for pre-tenant-context, platform-wide
-- reads), and every subsequent query made on the key's behalf goes
-- through the normal tenant-scoped RLS path once that lookup
-- establishes which tenant it belongs to.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE api_keys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           TEXT NOT NULL CHECK (length(trim(name)) > 0),
  key_prefix     TEXT NOT NULL,
  key_hash       TEXT NOT NULL UNIQUE,
  scopes         TEXT[] NOT NULL DEFAULT ARRAY['read']::text[]
                   CHECK (scopes <@ ARRAY['read', 'write']::text[] AND array_length(scopes, 1) > 0),
  created_by     UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  revoked_by     UUID REFERENCES users(id)
);

CREATE INDEX idx_api_keys_tenant ON api_keys (tenant_id);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON api_keys TO sentinel_app;

COMMIT;
