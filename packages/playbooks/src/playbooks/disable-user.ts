import type { GraphClient, Playbook, PlaybookTarget, PremiseCheckResult } from '../types.js';

interface DisableUserTarget extends PlaybookTarget {
  userId: string;
  expectedUpn: string;
}

function isTarget(t: PlaybookTarget): t is DisableUserTarget {
  return typeof t['userId'] === 'string' && typeof t['expectedUpn'] === 'string';
}

export const disableUser: Playbook = {
  id: 'disable_user',
  blastRadius: 'disable this user account',
  requiredScopes: ['User.ReadWrite.All'],
  requiresStepUp: true,
  reversalProcedure: 'PATCH the same user with accountEnabled: true (Graph "Enable user") — reversible at any time, with no data loss.',

  async validatePremise(graph: GraphClient, target: PlaybookTarget): Promise<PremiseCheckResult> {
    if (!isTarget(target)) return { ok: false, reason: 'malformed target: expected { userId, expectedUpn }' };
    const res = await graph.get(`/users/${target.userId}?$select=userPrincipalName`);
    if (res.status === 404) return { ok: false, reason: `user ${target.userId} no longer exists` };
    if (res.status !== 200) return { ok: false, reason: `unexpected Graph response ${res.status} reading the target user` };
    const body = res.body as { userPrincipalName?: string };
    if (body.userPrincipalName !== target.expectedUpn) {
      return { ok: false, reason: `target user's UPN (${body.userPrincipalName ?? 'unknown'}) no longer matches the case's premise (${target.expectedUpn})` };
    }
    return { ok: true };
  },

  async execute(graph: GraphClient, target: PlaybookTarget) {
    if (!isTarget(target)) return { ok: false as const, recoverable: false, manualSteps: 'target was malformed', error: 'malformed target' };

    // Idempotent: already-disabled is success, not a second PATCH.
    const current = await graph.get(`/users/${target.userId}?$select=accountEnabled`);
    if (current.status === 200 && (current.body as { accountEnabled?: boolean }).accountEnabled === false) {
      return { ok: true as const };
    }

    const res = await graph.patch(`/users/${target.userId}`, { accountEnabled: false });
    if (res.status === 204) return { ok: true as const };
    return {
      ok: false as const,
      recoverable: true,
      manualSteps: `Disable the user manually in the Microsoft 365 admin center (user id ${target.userId}).`,
      error: `Graph PATCH /users/${target.userId} returned ${res.status}`,
    };
  },
};
