/**
 * P4-03 T1/T3/T4: the Verdict validator (verdict-validation.ts) — pure,
 * no network, no model involved.
 */
import { describe, expect, it } from 'vitest';
import { validateVerdict, formatValidationErrors } from '../verdict-validation.js';

function wellFormedVerdict() {
  return {
    severity: 'high',
    title: 'Suspicious sign-in from a new country',
    claims: [{ text: 'A sign-in occurred from an unrecognised ASN', evidenceRef: ['evt_1', 'evt_2'] }],
    attackChain: ['T1078'],
    recommendedActions: [{ playbook: 'revoke_sessions', urgency: 'now', blastRadius: 'single_user' }],
  };
}

describe('validateVerdict', () => {
  it('T1: a well-formed verdict parses successfully', () => {
    const result = validateVerdict(wellFormedVerdict());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.severity).toBe('high');
      expect(result.verdict.recommendedActions[0]?.playbook).toBe('revoke_sessions');
    }
  });

  it('AC5: severity is constrained to the defined enumeration', () => {
    const result = validateVerdict({ ...wellFormedVerdict(), severity: 'catastrophic' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(formatValidationErrors(result.errors)).toContain('severity');
    }
  });

  it('T3: a verdict referencing an unknown playbook is rejected', () => {
    const verdict = wellFormedVerdict();
    verdict.recommendedActions[0]!.playbook = 'launch_the_nukes';
    const result = validateVerdict(verdict);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(formatValidationErrors(result.errors)).toContain('unknown playbook');
    }
  });

  it('T4: a claim with an empty evidenceRef array is rejected at parse time', () => {
    const verdict = wellFormedVerdict();
    verdict.claims[0]!.evidenceRef = [];
    const result = validateVerdict(verdict);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(formatValidationErrors(result.errors)).toContain('claims[0].evidenceRef');
    }
  });

  it('rejects a non-object payload outright', () => {
    const result = validateVerdict('just a string');
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown urgency value', () => {
    const verdict = wellFormedVerdict();
    verdict.recommendedActions[0]!.urgency = 'eventually' as never;
    const result = validateVerdict(verdict);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(formatValidationErrors(result.errors)).toContain('urgency');
    }
  });

  it('reports every structural problem in one pass, not just the first', () => {
    const result = validateVerdict({ severity: 'nope', title: '', claims: 'not-an-array', attackChain: [], recommendedActions: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);
      expect(paths).toEqual(expect.arrayContaining(['severity', 'title', 'claims']));
    }
  });
});
