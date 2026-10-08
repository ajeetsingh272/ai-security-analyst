-- ─────────────────────────────────────────────────────────────────────────────
-- 0021 · tenant_pre_approvals
--
-- P5-06: "customers can later allow specific safe actions to run
-- automatically — their choice, their control." One row per GRANT (not
-- a single toggled row per playbook) — mirrors suppressions/
-- hotfix_rules' own revoke-rather-than-delete shape, so the full
-- grant/revoke history survives even after a revoke, which the audit
-- log itself only has half of (it says WHO revoked WHEN; this table is
-- what a later grant's own history is checked against).
--
-- The CHECK constraint is a real, second enforcement of "destructive
-- playbooks cannot be pre-approved at all" (AC2/T2's own security
-- test) — not merely a mirror of the same list in step-up.ts's
-- DESTRUCTIVE_PLAYBOOKS for documentation's sake. A bug in the
-- application-level check (PreApprovalRepository.grant) still cannot
-- produce a row Postgres itself refuses, the same defense-in-depth
-- relationship approval_nonces' own PRIMARY KEY has to its
-- application-level duplicate check.
--
-- The partial unique index enforces "at most one ACTIVE grant per
-- (tenant, playbook)" without blocking a LATER re-grant after a
-- revoke — a second CREATE for an already-active playbook is a
-- conflict (the application should check first), but granting again
-- after revoking is a completely ordinary thing to do.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE tenant_pre_approvals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  playbook    TEXT NOT NULL,
  granted_by  UUID NOT NULL REFERENCES users(id),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  revoked_by  UUID REFERENCES users(id),
  CONSTRAINT tenant_pre_approvals_playbook_check
    CHECK (playbook = ANY (ARRAY['disable_user', 'revoke_sessions', 'delete_inbox_rule', 'block_ip', 'force_password_reset', 'isolate_device'])),
  -- disable_user/isolate_device/force_password_reset are exactly
  -- step-up.ts's own DESTRUCTIVE_PLAYBOOKS — never pre-approvable,
  -- because pre-approval means executing with no human present AT
  -- ALL, and step-up re-authentication has no human to challenge.
  CONSTRAINT tenant_pre_approvals_no_destructive_playbooks
    CHECK (playbook NOT IN ('disable_user', 'isolate_device', 'force_password_reset'))
);

CREATE UNIQUE INDEX idx_tenant_pre_approvals_one_active ON tenant_pre_approvals (tenant_id, playbook) WHERE revoked_at IS NULL;

ALTER TABLE tenant_pre_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_pre_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_pre_approvals
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON tenant_pre_approvals TO sentinel_app;

COMMIT;
