-- ─────────────────────────────────────────────────────────────────────────────
-- 0018 · notifications
--
-- P5-01: the notification abstraction's own storage. Two tables:
--
-- notification_deliveries — one row per delivery ATTEMPT (not per alert),
-- so "every attempt is retried with backoff and recorded" (AC3/T3) is a
-- real, queryable history rather than a single mutated "latest status"
-- row that overwrites its own evidence of an earlier failed attempt.
-- `content` holds exactly what was handed to that channel at send time —
-- the dashboard_banner channel has no delivery mechanism of its own
-- (P5-01 ships no dashboard UI), so a 'sent' row's own `content` IS the
-- banner's data; a future dashboard surface reads it directly rather than
-- needing a second table.
--
-- The partial unique index is T4's own enforcement, the same way
-- `approval_nonces`' PRIMARY KEY is P5-03's: the uniqueness constraint
-- makes "don't send the same alert twice on one channel" true even under
-- a race between two dispatch attempts, not merely true because the
-- application checked first and nothing else ever will.
--
-- tenant_notification_preferences — one row per tenant that has ever
-- customised its failover order; absence of a row means "use the
-- platform default" (AC2), so onboarding a tenant never requires seeding
-- this table.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE notification_deliveries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dedupe_key   TEXT NOT NULL,
  channel      TEXT NOT NULL,
  attempt      INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL,
  content      JSONB,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT notification_deliveries_channel_check CHECK (channel = ANY (ARRAY['whatsapp', 'slack', 'email', 'dashboard_banner'])),
  CONSTRAINT notification_deliveries_status_check CHECK (status = ANY (ARRAY['sent', 'failed']))
);

CREATE INDEX idx_notification_deliveries_dedupe ON notification_deliveries (tenant_id, dedupe_key);

-- T4: at most one SUCCESSFUL delivery per (tenant, alert, channel), enforced
-- by Postgres itself rather than only by an application-level check-then-act
-- that a concurrent dispatch could race past.
CREATE UNIQUE INDEX idx_notification_deliveries_sent_once ON notification_deliveries (tenant_id, dedupe_key, channel) WHERE status = 'sent';

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_deliveries
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON notification_deliveries TO sentinel_app;

CREATE TABLE tenant_notification_preferences (
  tenant_id     UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  channel_order TEXT[] NOT NULL DEFAULT ARRAY['whatsapp', 'slack', 'email', 'dashboard_banner'],
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenant_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_notification_preferences
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON tenant_notification_preferences TO sentinel_app;

COMMIT;
