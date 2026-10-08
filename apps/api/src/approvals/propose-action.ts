/**
 * P5-06: "propose an action" that checks the tenant's own pre-approval
 * policy immediately — if the playbook is pre-approved, it auto-
 * approves and executes right here, with no human prompted at all
 * (AC1/T1); otherwise it is left exactly as ActionsRepository.
 * proposeAction created it (`proposed`), for whatever sends the
 * eventual approval link (the already-built @sentinel/notifications +
 * @sentinel/approval-tokens machinery — wiring a real CALLER of that
 * for a freshly-proposed action is the AI analyst plane's own job,
 * P4, not this ticket's).
 */
import type { Pool } from 'pg';
import { ActionsRepository, PreApprovalRepository, withTenantContext, type ActionRow } from '@sentinel/db';
import type { NotificationDispatcher } from '@sentinel/notifications';
import { executeApprovedAction } from './execute-action.js';

export async function proposeAction(
  pool: Pool,
  dispatcher: NotificationDispatcher | undefined,
  tenantId: string,
  caseId: string,
  playbook: string,
  target: unknown,
  blastRadius: string,
): Promise<ActionRow> {
  return withTenantContext(tenantId, async () => {
    const actions = new ActionsRepository(pool);
    const proposed = await actions.proposeAction(caseId, playbook, target, blastRadius);

    const preApproved = await new PreApprovalRepository(pool).isPreApproved(playbook);
    if (!preApproved) return proposed;

    // T1: auto-approve + execute, no prompt. autoApprove's own guard
    // (proposed -> approved) means this cannot double-fire even if
    // called twice for the same action.
    if (!(await actions.autoApprove(proposed.id, caseId))) return proposed;
    await executeApprovedAction(pool, tenantId, proposed);

    // AC5/T4: "reported to the tenant within the hour" — dispatched
    // immediately (trivially inside that window), via the
    // dashboard_banner channel @sentinel/notifications ships for real
    // (P5-01) — no external credentials needed, unlike WhatsApp/Slack/
    // email, so this never silently fails to notify just because
    // nothing else is configured yet.
    if (dispatcher) {
      await dispatcher.dispatch({
        tenantId,
        dedupeKey: `pre-approved-execution:${proposed.id}`,
        content: { dashboard_banner: { title: 'Action executed automatically (pre-approved)', playbook, actionId: proposed.id, caseId } },
      });
    }

    return (await actions.findById(proposed.id)) ?? proposed;
  });
}
