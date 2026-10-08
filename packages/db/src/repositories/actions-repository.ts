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
  /**
   * P5-06: the "propose an action" entry point this table has never
   * had until now — every other method here only reads or transitions
   * an already-existing row (P5-02/03/05's own fixtures all INSERT
   * directly in their tests because nothing else created one yet).
   * Whatever eventually turns a Verdict's own recommendedActions into
   * real rows (the AI analyst plane, P4) should call this rather than
   * duplicate the INSERT.
   */
  async proposeAction(caseId: string, playbook: string, target: unknown, blastRadius: string): Promise<ActionRow> {
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
        `INSERT INTO actions (tenant_id, case_id, playbook, target, blast_radius)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, tenant_id, case_id, playbook, target, blast_radius, status, error, created_at, executed_at`,
        [this.tenantId, caseId, playbook, JSON.stringify(target), blastRadius],
      );
      const r = rows[0]!;
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
   *
   * `stepUpVerified` (P5-04 AC4: "step-up completion is recorded in
   * the audit entry for the action") is undefined for a playbook that
   * never required it, and true for one that did and passed — approve()
   * is never even called for one that required step-up and failed (the
   * caller, approvals.ts, stops before reaching this method at all).
   */
  async approve(actionId: string, caseId: string, approverId: string, stepUpVerified?: boolean): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const result = await client.query(`UPDATE actions SET status = 'approved' WHERE id = $1 AND case_id = $2 AND status = 'proposed'`, [actionId, caseId]);
      if (result.rowCount !== 1) return false;

      await writeAuditEntryTx(client, this.tenantId, {
        actorType: 'human',
        actorId: approverId,
        action: 'approval_granted',
        subjectType: 'action',
        subjectId: actionId,
        payload: stepUpVerified === undefined ? { case_id: caseId } : { case_id: caseId, step_up_verified: stepUpVerified },
      });
      return true;
    });
  }

  /**
   * P5-06: the pre-approval path's own "approve" — same transition
   * and guard as approve(), but `actorType: 'system'` rather than
   * 'human' (ADR-0007's own "clean separation of AI-initiated from
   * human-approved decisions in the record") and a fixed actor id,
   * since nothing a human did authorizes this specific action; the
   * tenant's own prior PreApprovalRepository.grant() call is what
   * authorized it, and that grant has its own audit entry already.
   * Never called for a destructive playbook — PreApprovalRepository
   * itself refuses to let one be pre-approved in the first place.
   */
  async autoApprove(actionId: string, caseId: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const result = await client.query(`UPDATE actions SET status = 'approved' WHERE id = $1 AND case_id = $2 AND status = 'proposed'`, [actionId, caseId]);
      if (result.rowCount !== 1) return false;

      await writeAuditEntryTx(client, this.tenantId, {
        actorType: 'system',
        actorId: 'sentinel-pre-approval',
        action: 'approval_granted',
        subjectType: 'action',
        subjectId: actionId,
        payload: { case_id: caseId, pre_approved: true },
      });
      return true;
    });
  }

  /** P5-05: approved -> executing, guarded the same way approve() is —
   * only an action genuinely in `approved` can start executing, so a
   * duplicate trigger (e.g. a retried request) cannot start two
   * concurrent executions of the same action. */
  async markExecuting(actionId: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const result = await client.query(`UPDATE actions SET status = 'executing' WHERE id = $1 AND status = 'approved'`, [actionId]);
      return result.rowCount === 1;
    });
  }

  /** executing -> succeeded, with the "before and after" audit entry
   * AC5 asks for (approve()'s own approval_granted write is the
   * "before"; this is the "after"). */
  async markSucceeded(actionId: string): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(`UPDATE actions SET status = 'succeeded', executed_at = now() WHERE id = $1`, [actionId]);
      await writeAuditEntryTx(client, this.tenantId, {
        actorType: 'system',
        actorId: 'sentinel-response',
        action: 'action_completed',
        subjectType: 'action',
        subjectId: actionId,
      });
    });
  }

  /** executing -> failed. AC4: "a recorded, recoverable state with
   * explicit manual steps" — `manualSteps` and `error` both land in
   * the action's own row (queryable without digging through the audit
   * log) AND in the audit entry's payload (the permanent record). */
  async markFailed(actionId: string, error: string, manualSteps: string): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(`UPDATE actions SET status = 'failed', error = $2 WHERE id = $1`, [actionId, error]);
      await writeAuditEntryTx(client, this.tenantId, {
        actorType: 'system',
        actorId: 'sentinel-response',
        action: 'action_failed',
        subjectType: 'action',
        subjectId: actionId,
        payload: { error, manual_steps: manualSteps },
      });
    });
  }
}
