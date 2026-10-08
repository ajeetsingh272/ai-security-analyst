/**
 * Device isolation is a Defender for Endpoint / Intune capability
 * (Graph's `/security/...` or `/deviceManagement/...` surface under a
 * DIFFERENT license and consent scope than the M365 mail/directory
 * scopes this platform's connector already requests, P1-02's own
 * M365_SCOPES) — not configured or consented to anywhere in this
 * codebase. Same honest treatment as block-ip.ts: a real, correctly
 * specified registry entry whose `execute` always hands back a
 * recoverable manual step, not a fabricated success.
 */
import type { GraphClient, Playbook, PlaybookTarget, PremiseCheckResult } from '../types.js';

interface IsolateDeviceTarget extends PlaybookTarget {
  deviceId: string;
}

function isTarget(t: PlaybookTarget): t is IsolateDeviceTarget {
  return typeof t['deviceId'] === 'string';
}

export const isolateDevice: Playbook = {
  id: 'isolate_device',
  blastRadius: 'disconnect this device from the network',
  requiredScopes: [],
  requiresStepUp: true,
  reversalProcedure: 'Un-isolate the device from the Defender for Endpoint / Intune console once an operator has set up that integration.',

  async validatePremise(_graph: GraphClient, target: PlaybookTarget): Promise<PremiseCheckResult> {
    if (!isTarget(target)) return { ok: false, reason: 'malformed target: expected { deviceId }' };
    return { ok: true };
  },

  async execute(_graph: GraphClient, target: PlaybookTarget) {
    if (!isTarget(target)) return { ok: false as const, recoverable: false, manualSteps: 'target was malformed', error: 'malformed target' };
    return {
      ok: false as const,
      recoverable: true,
      manualSteps: `No Defender for Endpoint / Intune integration exists yet — isolate device ${target.deviceId} manually from that console.`,
      error: 'isolate_device has no automated backend yet',
    };
  },
};
