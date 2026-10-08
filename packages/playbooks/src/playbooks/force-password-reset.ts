import type { GraphClient, Playbook, PlaybookTarget, PremiseCheckResult } from '../types.js';

interface ForcePasswordResetTarget extends PlaybookTarget {
  userId: string;
  expectedUpn: string;
}

function isTarget(t: PlaybookTarget): t is ForcePasswordResetTarget {
  return typeof t['userId'] === 'string' && typeof t['expectedUpn'] === 'string';
}

export const forcePasswordReset: Playbook = {
  id: 'force_password_reset',
  blastRadius: 'require a new password before the account can be used again',
  requiredScopes: ['User.ReadWrite.All'],
  requiresStepUp: true,
  reversalProcedure: 'PATCH the same user with passwordProfile.forceChangePasswordNextSignIn: false — the user keeps their current password and is not prompted again.',

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

    const current = await graph.get(`/users/${target.userId}?$select=passwordProfile`);
    const currentFlag = (current.body as { passwordProfile?: { forceChangePasswordNextSignIn?: boolean } })?.passwordProfile?.forceChangePasswordNextSignIn;
    if (current.status === 200 && currentFlag === true) return { ok: true as const };

    const res = await graph.patch(`/users/${target.userId}`, { passwordProfile: { forceChangePasswordNextSignIn: true } });
    if (res.status === 204) return { ok: true as const };
    return {
      ok: false as const,
      recoverable: true,
      manualSteps: `Force a password reset manually in the Microsoft 365 admin center (user id ${target.userId}).`,
      error: `Graph PATCH /users/${target.userId} returned ${res.status}`,
    };
  },
};
