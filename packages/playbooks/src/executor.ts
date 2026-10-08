/**
 * P5-05: validate-then-execute, in that order, always — the one rule
 * this file exists to guarantee (AC3/T3: a playbook whose target no
 * longer matches the case's premise must never reach `execute` at
 * all). No Postgres/audit access here — the caller (apps/api's
 * approvals route) owns transitioning the action's own status and
 * writing its audit entries; this function only ever returns what
 * happened, the same infra-agnostic split @sentinel/notifications'
 * dispatcher and @sentinel/approval-tokens' token verification already
 * use.
 */
import { getPlaybook } from './registry.js';
import type { ExecutionOutcome, GraphClient, PlaybookTarget } from './types.js';

export type PlaybookExecutionResult =
  | { kind: 'unknown_playbook' }
  | { kind: 'premise_mismatch'; reason: string }
  | { kind: 'executed'; outcome: ExecutionOutcome };

export async function executePlaybook(playbookId: string, graph: GraphClient, target: PlaybookTarget): Promise<PlaybookExecutionResult> {
  const playbook = getPlaybook(playbookId);
  if (!playbook) return { kind: 'unknown_playbook' };

  const premise = await playbook.validatePremise(graph, target);
  if (!premise.ok) return { kind: 'premise_mismatch', reason: premise.reason };

  const outcome = await playbook.execute(graph, target);
  return { kind: 'executed', outcome };
}
