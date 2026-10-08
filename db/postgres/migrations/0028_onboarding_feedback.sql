-- ─────────────────────────────────────────────────────────────────────────────
-- 0028 · feedback / tuning_backlog_items
--
-- P6-12: in-product feedback attached to a case or a weekly report
-- (`feedback`), and the queue a customer's own false-positive report
-- automatically feeds (`tuning_backlog_items`) — a human-reviewed
-- queue, not something that writes a live suppression or hotfix rule
-- unreviewed. `tuning_backlog_items.case_id`/`rule_id` are both
-- nullable: a report's own feedback has no single case to point at,
-- and a case's own signals might not resolve to exactly one rule.
--
-- There is no dedicated "signup" event anywhere in this product
-- (tenants are always created out-of-band, never through a product
-- signup flow) — `tenants.created_at` is the only honest t0 for the
-- onboarding funnel these two tables feed into (see apps/api/src/
-- onboarding.ts's own doc comment).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE feedback (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_type       TEXT NOT NULL CHECK (subject_type IN ('case', 'weekly_report')),
  subject_id         UUID NOT NULL,
  user_id            UUID NOT NULL REFERENCES users(id),
  is_false_positive  BOOLEAN NOT NULL DEFAULT false,
  comment            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_feedback_tenant_subject ON feedback (tenant_id, subject_type, subject_id);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON feedback
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON feedback TO sentinel_app;

CREATE TABLE tuning_backlog_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id     UUID REFERENCES cases(id) ON DELETE SET NULL,
  rule_id     TEXT,
  source      TEXT NOT NULL DEFAULT 'customer_feedback',
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'applied', 'dismissed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tuning_backlog_tenant_status ON tuning_backlog_items (tenant_id, status);

ALTER TABLE tuning_backlog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tuning_backlog_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tuning_backlog_items
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON tuning_backlog_items TO sentinel_app;

COMMIT;
