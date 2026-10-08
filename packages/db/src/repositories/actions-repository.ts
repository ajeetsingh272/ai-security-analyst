/**
 * P5-02's own minimal slice of the `actions` table (P0 foundation) — a
 * single-row lookup by id, scoped to the current tenant via RLS, used
 * by the WhatsApp webhook to resolve an interactive button tap back to
 * the action it refers to. P5-05 ("Response playbook registry and
 * executor") owns the real `actions` lifecycle — creating rows,
 * transitioning status, executing playbooks — and should extend this
 * class rather than duplicate it when it lands.
 */
import { TenantScopedRepository } from '../tenant-context.js';
import { writeAuditEntryTx } from '../audit/audit-log-writer.js';

export interface ActionRow {
  id: string;
  tenantId: string;
  caseId: string;
  playbook: string;
  target: unknown;
  blastRadius: string;
  status: string;
  error: string | null;
  createdAt: string;
  executedAt: string | null;
}

export class ActionsRepository extends TenantScopedRepository {
  /** Returns null both when the id does not exist AND when it belongs
   * to a different tenant (RLS filters it out identically either way) —
   * a caller cannot distinguish "wrong id" from "someone else's action"
   * from this method alone, which is the point (P0-05/TG5). */
  async findById(actionId: string): Promise<ActionRow | null> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        case_id: string;
        playbook: string;
        target: unknown;
        blast_radius: string;
        status: string;
        error: string | null;
        created_at: string;
        executed_at: string | null;
      }>(
        `SELECT id, tenant_id, case_id, playbook, target, blast_radius, status, error, created_at, executed_at
         FROM actions WHERE id = $1`,
        [actionId],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        tenantId: r.tenant_id,
        caseId: r.case_id,
        playbook: r.playbook,
        target: r.target,
        blastRadius: r.blast_radius,
        status: r.status,
        error: r.error,
        createdAt: r.created_at,
        executedAt: r.executed_at,
      };
    });
  }

  /**
   * P5-03/ADR-0007: transitions a proposed action to approved and
   * writes the audit entry in the SAME transaction — mirrors
   * CasesRepository.challengeDismissal's own "read the current state,
   * write one transition, audit it with the already-open client" shape.
   * Returns false (no-op, not an error) when the action is missing,
   * belongs to a different case, or was not in `proposed` — a second
   * approval attempt on an already-decided action must not re-fire the
   * audit entry or silently succeed twice.
   */
  async approve(actionId: string, caseId: string, approverId: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const result = await client.query(`UPDATE actions SET status = 'approved' WHERE id = $1 AND case_id = $2 AND status = 'proposed'`, [actionId, caseId]);
      if (result.rowCount !== 1) return false;

      await writeAuditEntryTx(client, this.tenantId, {
        actorType: 'human',
        actorId: approverId,
        action: 'approval_granted',
        subjectType: 'action',
        subjectId: actionId,
        payload: { case_id: caseId },
      });
      return true;
    });
  }
}
