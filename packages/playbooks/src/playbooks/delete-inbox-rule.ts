import type { GraphClient, Playbook, PlaybookTarget, PremiseCheckResult } from '../types.js';

interface DeleteInboxRuleTarget extends PlaybookTarget {
  userId: string;
  ruleId: string;
  expectedRuleName: string;
}

function isTarget(t: PlaybookTarget): t is DeleteInboxRuleTarget {
  return typeof t['userId'] === 'string' && typeof t['ruleId'] === 'string' && typeof t['expectedRuleName'] === 'string';
}

export const deleteInboxRule: Playbook = {
  id: 'delete_inbox_rule',
  blastRadius: 'remove the automatic mailbox rule that was created',
  requiredScopes: ['MailboxSettings.ReadWrite'],
  requiresStepUp: false,
  reversalProcedure: 'Not reversible from the rule\'s own deleted state (Graph does not restore a deleted rule) — the rule\'s captured displayName/conditions/actions are kept in the action\'s own audit payload so an operator can recreate it by hand if it turns out to have been legitimate.',

  async validatePremise(graph: GraphClient, target: PlaybookTarget): Promise<PremiseCheckResult> {
    if (!isTarget(target)) return { ok: false, reason: 'malformed target: expected { userId, ruleId, expectedRuleName }' };
    const res = await graph.get(`/users/${target.userId}/mailFolders/inbox/messageRules/${target.ruleId}`);
    if (res.status === 404) {
      // Already gone — not a premise mismatch (someone/something else
      // already handled it), execute() below will see this as done too.
      return { ok: true };
    }
    if (res.status !== 200) return { ok: false, reason: `unexpected Graph response ${res.status} reading the target rule` };
    const body = res.body as { displayName?: string };
    if (body.displayName !== target.expectedRuleName) {
      return { ok: false, reason: `target rule's name (${body.displayName ?? 'unknown'}) no longer matches the case's premise (${target.expectedRuleName}) — may be a reused id` };
    }
    return { ok: true };
  },

  async execute(graph: GraphClient, target: PlaybookTarget) {
    if (!isTarget(target)) return { ok: false as const, recoverable: false, manualSteps: 'target was malformed', error: 'malformed target' };

    const res = await graph.delete(`/users/${target.userId}/mailFolders/inbox/messageRules/${target.ruleId}`);
    // 404 here means it was already deleted by the time of THIS call
    // (validatePremise's own read and this delete are not atomic) —
    // still success, not a second side effect either way.
    if (res.status === 204 || res.status === 404) return { ok: true as const };
    return {
      ok: false as const,
      recoverable: true,
      manualSteps: `Delete the mailbox rule "${target.expectedRuleName}" manually (user id ${target.userId}, rule id ${target.ruleId}).`,
      error: `Graph DELETE .../messageRules/${target.ruleId} returned ${res.status}`,
    };
  },
};
