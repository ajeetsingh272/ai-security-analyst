/**
 * P5-05/P5-06: the "execute an already-approved action and record the
 * outcome" logic, factored out of approvals.ts's own POST handler so
 * P5-06's pre-approval auto-execution path (propose-action.ts) can
 * call the exact same code rather than duplicate it — a human tapping
 * Approve and a tenant's own pre-approval policy triggering execution
 * are two different ways to REACH 'approved'; what happens once an
 * action IS approved is identical either way.
 *
 * Must run with the tenant's context already active (ActionsRepository/
 * CasesRepository both require it) — the caller establishes that, the
 * same convention every other repository-using function in this app
 * follows.
 */
import type { Pool } from 'pg';
import { ActionsRepository, CasesRepository, type ActionRow } from '@sentinel/db';
import { executePlaybook, FetchGraphClient, type GraphClient, type GraphResponse, type PlaybookTarget } from '@sentinel/playbooks';
import { getM365AccessToken } from './graph-access.js';

/** Used whenever no M365 connection exists for this tenant — every
 * call fails the same way a real outage would, so playbooks that DO
 * call Graph (disable_user, revoke_sessions, ...) get the honest
 * "can't reach it" failure through their own normal error path, while
 * the two not-yet-integrated playbooks (block_ip, isolate_device),
 * which never call `graph` at all, are entirely unaffected by whether
 * a connection exists. */
const UNAVAILABLE_GRAPH_RESPONSE: GraphResponse = { status: 503, body: null };
const unavailableGraphClient: GraphClient = {
  get: async () => UNAVAILABLE_GRAPH_RESPONSE,
  patch: async () => UNAVAILABLE_GRAPH_RESPONSE,
  post: async () => UNAVAILABLE_GRAPH_RESPONSE,
  delete: async () => UNAVAILABLE_GRAPH_RESPONSE,
};

/**
 * approved -> executing -> succeeded|failed. A no-op (returns
 * immediately) if the action is not genuinely in `approved` —
 * markExecuting's own guard — so calling this twice on the same
 * action can never start two concurrent executions.
 */
export async function executeApprovedAction(pool: Pool, tenantId: string, action: ActionRow): Promise<void> {
  const actions = new ActionsRepository(pool);
  if (!(await actions.markExecuting(action.id))) return;

  const accessToken = await getM365AccessToken(pool, tenantId);
  // GRAPH_API_BASE_URL overrides the real Microsoft Graph host —
  // unset in every real deployment; P5-10's own end-to-end scenario
  // test is the one caller that sets it, to point at a local mock.
  const graph = accessToken ? new FetchGraphClient(accessToken, process.env['GRAPH_API_BASE_URL']) : unavailableGraphClient;
  const execResult = await executePlaybook(action.playbook, graph, action.target as PlaybookTarget);

  if (execResult.kind === 'executed' && execResult.outcome.ok) {
    await actions.markSucceeded(action.id);
    return;
  }

  const { error, manualSteps } =
    execResult.kind === 'executed' && !execResult.outcome.ok
      ? { error: execResult.outcome.error, manualSteps: execResult.outcome.manualSteps }
      : execResult.kind === 'premise_mismatch'
        ? { error: execResult.reason, manualSteps: `The premise for this action no longer holds (${execResult.reason}) — review the case and act manually if still needed.` }
        : { error: `unknown playbook: ${action.playbook}`, manualSteps: 'This action references a playbook this version does not recognise — resolve it manually.' };

  await actions.markFailed(action.id, error, manualSteps);
  await new CasesRepository(pool).returnToAwaitingApproval(action.caseId, `action ${action.id} (${action.playbook}) failed: ${error}`);
}
