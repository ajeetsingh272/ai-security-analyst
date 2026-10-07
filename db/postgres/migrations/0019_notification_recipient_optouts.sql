-- ─────────────────────────────────────────────────────────────────────────────
-- 0019 · notification_recipient_optouts
--
-- P5-02 AC4: "opt-in and opt-out are handled per regulation and
-- recorded." Scoped per (tenant, channel, recipient) rather than
-- globally per tenant — a tenant's own owner opting a personal phone
-- number out of WhatsApp alerts must not silently opt out some OTHER
-- recipient the tenant has also configured (e.g. an MSP's on-call
-- rotation), and must not touch Slack or email either.
--
-- PRIMARY KEY doubles as the idempotency guarantee: recording the same
-- opt-out twice (a user replying STOP more than once) is a normal,
-- expected occurrence, not an error.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE notification_recipient_optouts (
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL,
  recipient     TEXT NOT NULL,
  opted_out_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel, recipient),
  CONSTRAINT notification_recipient_optouts_channel_check CHECK (channel = ANY (ARRAY['whatsapp', 'slack', 'email', 'dashboard_banner']))
);

ALTER TABLE notification_recipient_optouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_recipient_optouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_recipient_optouts
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, DELETE ON notification_recipient_optouts TO sentinel_app;

COMMIT;
