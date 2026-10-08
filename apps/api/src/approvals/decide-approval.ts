/**
 * P5-03/04/05/07: "verify a token, decide, execute" — factored out of
 * approvals.ts's own POST handler so Slack's own interactive button
 * (slack-webhook.ts) can reach the EXACT same decision logic a human
 * tapping the WhatsApp/dashboard link does, rather than a second copy
 * of step-up/approve/execute with its own chance to drift. The two
 * callers differ only in how they got here (an HTTP path param vs. a
 * button's own opaque value) and in what they do with the RESULT
 * (approvals.ts renders JSON; slack-webhook.ts posts back to Slack's
 * response_url) — everything up to and including execution is shared.
 */
import type { Pool } from 'pg';
import { AuditLogWriter, ActionsRepository, withTenantContext } from '@sentinel/db';
import { verifyAndConsume, type ApprovalTokenVerifyError, type ApprovalTokenVerifyResult, type NonceStore } from '@sentinel/approval-tokens';
import { requiresStepUp, verifyStepUpPassword } from './step-up.js';
import { executeApprovedAction } from './execute-action.js';

export const APPROVAL_ERROR_MESSAGES: Record<ApprovalTokenVerifyError, string> = {
  malformed: 'This link is not a valid approval link.',
  bad_signature: 'This link is not a valid approval link.',
  expired: 'This link has expired. Links are valid for 15 minutes — please use the dashboard instead.',
  reused: 'This link has already been used.',
};

export type DecideApprovalOutcome =
  | { kind: 'rejected'; error: ApprovalTokenVerifyError }
  | { kind: 'not_found' }
  | { kind: 'step_up_failed' }
  | { kind: 'decided'; approved: boolean };

/** malformed/bad_signature never carry a trustworthy payload (see
 * @sentinel/approval-tokens' own ApprovalTokenVerifyResult doc
 * comment) — there is no tenant to scope an audit entry to, so none
 * is written for those two kinds. expired/reused always do, since by
 * definition the signature already checked out by the time either
 * can occur. */
async function auditRejection(pool: Pool, result: Extract<ApprovalTokenVerifyResult, { ok: false }>): Promise<void> {
  if (!('payload' in result)) return;
  const { payload } = result;
  await withTenantContext(payload.tenantId, () =>
    new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: payload.approverId,
      action: 'approval_rejected',
      subjectType: 'action',
      subjectId: payload.actionId,
      payload: { reason: result.error },
    }),
  );
}

export async function decideApproval(
  pool: Pool,
  nonceStore: NonceStore,
  tokenSecret: string | readonly string[],
  token: string,
  stepUpPassword: string | undefined,
): Promise<DecideApprovalOutcome> {
  const result = await verifyAndConsume(token, tokenSecret, nonceStore);
  if (!result.ok) {
    await auditRejection(pool, result);
    return { kind: 'rejected', error: result.error };
  }

  const { payload } = result;
  return withTenantContext(payload.tenantId, async () => {
    const actions = new ActionsRepository(pool);
    const action = await actions.findById(payload.actionId);
    if (!action || action.caseId !== payload.caseId) return { kind: 'not_found' as const };

    if (requiresStepUp(action.playbook)) {
      // T2 (P5-04): enforced here, server-side, regardless of what
      // called this endpoint — never only a UI-level gate.
      const stepUpOk = stepUpPassword ? await verifyStepUpPassword(pool, payload.approverId, stepUpPassword) : false;
      if (!stepUpOk) {
        // T4 (P5-04): the action is never touched — it stays exactly
        // where it was (`proposed`), not transitioned and then reverted.
        await new AuditLogWriter(pool).insert({
          actorType: 'human',
          actorId: payload.approverId,
          action: 'step_up_failed',
          subjectType: 'action',
          subjectId: payload.actionId,
          payload: { playbook: action.playbook },
        });
        return { kind: 'step_up_failed' as const };
      }
    }

    const approved = await actions.approve(payload.actionId, payload.caseId, payload.approverId, requiresStepUp(action.playbook) ? true : undefined);
    if (!approved) return { kind: 'decided' as const, approved: false };

    await executeApprovedAction(pool, payload.tenantId, action);
    return { kind: 'decided' as const, approved: true };
  });
}
