/**
 * P5-06: "customers can later allow specific safe actions to run
 * automatically — their choice, their control." Opt-in per playbook,
 * revocable, fully audited — every method below writes its own audit
 * entry in the SAME transaction as its table write, the same shape
 * CasesRepository.challengeDismissal already established.
 */
import { TenantScopedRepository } from '../tenant-context.js';
import { writeAuditEntryTx } from '../audit/audit-log-writer.js';

/** AC2/T2: the three playbooks step-up.ts's own DESTRUCTIVE_PLAYBOOKS
 * names — kept as a literal copy here (not an import of
 * apps/api's step-up module, which this package cannot depend on)
 * rather than a single shared source; the migration's own CHECK
 * constraint is the real, DB-level backstop if this list and that one
 * ever drift, the same defense-in-depth relationship
 * approval_nonces' PRIMARY KEY has to its own application-level check. */
const NEVER_PRE_APPROVABLE: ReadonlySet<string> = new Set(['disable_user', 'isolate_device', 'force_password_reset']);

export class DestructivePlaybookCannotBePreApprovedError extends Error {
  constructor(playbook: string) {
    super(`${playbook} is a destructive playbook and can never be pre-approved — it requires step-up authentication, which has no human to challenge once nothing prompts one.`);
    this.name = 'DestructivePlaybookCannotBePreApprovedError';
  }
}

export class PreApprovalRepository extends TenantScopedRepository {
  /** AC1/AC2: opt-in, one playbook at a time, never destructive.
   * Granting an already-active playbook again is a no-op success (the
   * migration's own partial unique index would otherwise reject the
   * second INSERT) — the caller asked for "pre-approved," and it
   * already is. */
  async grant(playbook: string, grantedBy: string): Promise<void> {
    if (NEVER_PRE_APPROVABLE.has(playbook)) {
      throw new DestructivePlaybookCannotBePreApprovedError(playbook);
    }
    await this.withTransaction(async (client) => {
      const alreadyActive = await client.query(`SELECT 1 FROM tenant_pre_approvals WHERE tenant_id = $1 AND playbook = $2 AND revoked_at IS NULL`, [this.tenantId, playbook]);
      if (alreadyActive.rows.length > 0) return;

      await client.query(`INSERT INTO tenant_pre_approvals (tenant_id, playbook, granted_by) VALUES ($1, $2, $3)`, [this.tenantId, playbook, grantedBy]);
      await writeAuditEntryTx(client, this.tenantId, {
        actorType: 'human',
        actorId: grantedBy,
        action: 'pre_approval_granted',
        subjectType: 'playbook',
        subjectId: playbook,
      });
    });
  }

  /** AC3/T3: "revocable immediately and takes effect on the next
   * action" — the next isPreApproved() call (which the executor path
   * calls fresh every time, never caching) sees revoked_at set and
   * returns false; there is no separate "effective at" delay to this. */
  async revoke(playbook: string, revokedBy: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE tenant_pre_approvals SET revoked_at = now(), revoked_by = $3 WHERE tenant_id = $1 AND playbook = $2 AND revoked_at IS NULL`,
        [this.tenantId, playbook, revokedBy],
      );
      if (result.rowCount !== 1) return false;

      await writeAuditEntryTx(client, this.tenantId, {
        actorType: 'human',
        actorId: revokedBy,
        action: 'pre_approval_revoked',
        subjectType: 'playbook',
        subjectId: playbook,
      });
      return true;
    });
  }

  async isPreApproved(playbook: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM tenant_pre_approvals WHERE tenant_id = $1 AND playbook = $2 AND revoked_at IS NULL`, [this.tenantId, playbook]);
      return rows.length > 0;
    });
  }
}
