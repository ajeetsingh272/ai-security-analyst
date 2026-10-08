import type { GraphClient, Playbook, PlaybookTarget, PremiseCheckResult } from '../types.js';

interface RevokeSessionsTarget extends PlaybookTarget {
  userId: string;
  expectedUpn: string;
}

function isTarget(t: PlaybookTarget): t is RevokeSessionsTarget {
  return typeof t['userId'] === 'string' && typeof t['expectedUpn'] === 'string';
}

export const revokeSessions: Playbook = {
  id: 'revoke_sessions',
  blastRadius: 'sign this user out of every active session',
  requiredScopes: ['User.RevokeSessions.All'],
  requiresStepUp: false,
  reversalProcedure: 'Not reversible — the user simply signs in again. Document this clearly to the approver before they tap Approve, not after.',

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

    // Naturally idempotent — Graph's own revokeSignInSessions always
    // returns success whether or not there was anything to revoke, so
    // there is no "already done" pre-check to make here (unlike
    // disable_user's own accountEnabled flag).
    const res = await graph.post(`/users/${target.userId}/revokeSignInSessions`);
    if (res.status === 200) return { ok: true as const };
    return {
      ok: false as const,
      recoverable: true,
      manualSteps: `Revoke this user's sessions manually in the Microsoft 365 admin center (user id ${target.userId}).`,
      error: `Graph POST /users/${target.userId}/revokeSignInSessions returned ${res.status}`,
    };
  },
};
