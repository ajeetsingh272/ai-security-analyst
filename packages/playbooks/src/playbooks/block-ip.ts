/**
 * No network/firewall integration exists anywhere in this codebase —
 * the platform's only real external integration today is Microsoft
 * 365 (P1-02). Blocking network access from an IP address is not a
 * Graph operation at all (it belongs to a firewall, SASE, or
 * conditional-access-by-location control this platform does not yet
 * manage). Declared here with its real blast radius/reversal/scopes
 * so it is a genuine, correctly-specified registry entry (AC1) rather
 * than missing outright — `execute` always returns a recoverable
 * failure with the manual step an operator takes right now, which is
 * the honest version of "not yet automatable," not a placeholder
 * pretending to succeed.
 */
import type { GraphClient, Playbook, PlaybookTarget, PremiseCheckResult } from '../types.js';

interface BlockIpTarget extends PlaybookTarget {
  ipAddress: string;
}

function isTarget(t: PlaybookTarget): t is BlockIpTarget {
  return typeof t['ipAddress'] === 'string';
}

export const blockIp: Playbook = {
  id: 'block_ip',
  blastRadius: 'block network access from this address',
  requiredScopes: [],
  requiresStepUp: false,
  reversalProcedure: 'Remove the manually-added block rule from whichever firewall/conditional-access policy an operator used to apply it.',

  async validatePremise(_graph: GraphClient, target: PlaybookTarget): Promise<PremiseCheckResult> {
    if (!isTarget(target)) return { ok: false, reason: 'malformed target: expected { ipAddress }' };
    return { ok: true };
  },

  async execute(_graph: GraphClient, target: PlaybookTarget) {
    if (!isTarget(target)) return { ok: false as const, recoverable: false, manualSteps: 'target was malformed', error: 'malformed target' };
    return {
      ok: false as const,
      recoverable: true,
      manualSteps: `No automated network/firewall integration exists yet — block ${target.ipAddress} manually at your firewall, VPN, or conditional-access policy.`,
      error: 'block_ip has no automated backend yet',
    };
  },
};
