import { describe, expect, it } from 'vitest';
import type { Verdict } from '@sentinel/schema';
import { diffVerdicts } from '../verdict-diff.js';

const BASE: Verdict = {
  severity: 'high',
  title: 'Suspicious sign-in',
  claims: [{ text: 'A sign-in from a new country', evidenceRef: ['evt_1'] }],
  attackChain: ['T1078'],
  recommendedActions: [{ playbook: 'revoke_sessions', urgency: 'now', blastRadius: 'one user' }],
};

describe('diffVerdicts', () => {
  it('AC5: two identical verdicts are materially equivalent', () => {
    const diff = diffVerdicts(BASE, { ...BASE });
    expect(diff.materiallyEquivalent).toBe(true);
    expect(diff.severityChanged).toBe(false);
    expect(diff.claimsAdded).toEqual([]);
    expect(diff.claimsRemoved).toEqual([]);
  });

  it('detects a severity change', () => {
    const diff = diffVerdicts(BASE, { ...BASE, severity: 'critical' });
    expect(diff.severityChanged).toBe(true);
    expect(diff.materiallyEquivalent).toBe(false);
    expect(diff.from.severity).toBe('high');
    expect(diff.to.severity).toBe('critical');
  });

  it('detects an added claim', () => {
    const extraClaim = { text: 'A second, new claim', evidenceRef: ['evt_2'] };
    const diff = diffVerdicts(BASE, { ...BASE, claims: [...BASE.claims, extraClaim] });
    expect(diff.claimsAdded).toEqual([extraClaim]);
    expect(diff.claimsRemoved).toEqual([]);
    expect(diff.materiallyEquivalent).toBe(false);
  });

  it('detects a removed claim', () => {
    const diff = diffVerdicts(BASE, { ...BASE, claims: [] });
    expect(diff.claimsRemoved).toEqual(BASE.claims);
    expect(diff.materiallyEquivalent).toBe(false);
  });

  it('a claim reordered but otherwise identical is NOT treated as added/removed', () => {
    const second = { text: 'second claim', evidenceRef: ['evt_2'] };
    const a: Verdict = { ...BASE, claims: [BASE.claims[0]!, second] };
    const b: Verdict = { ...BASE, claims: [second, BASE.claims[0]!] };
    const diff = diffVerdicts(a, b);
    expect(diff.claimsAdded).toEqual([]);
    expect(diff.claimsRemoved).toEqual([]);
  });

  it('detects an added and a removed recommended action', () => {
    const diff = diffVerdicts(BASE, { ...BASE, recommendedActions: [{ playbook: 'block_ip', urgency: 'now', blastRadius: 'n/a' }] });
    expect(diff.actionsRemoved).toEqual(BASE.recommendedActions);
    expect(diff.actionsAdded).toEqual([{ playbook: 'block_ip', urgency: 'now', blastRadius: 'n/a' }]);
  });

  it('detects a title change', () => {
    const diff = diffVerdicts(BASE, { ...BASE, title: 'A different title' });
    expect(diff.titleChanged).toBe(true);
  });
});
