/**
 * P4-08: the eval suite's own scoring/tolerance/drift logic — pure,
 * no infra, no model. This is what proves the HARNESS is correct;
 * whether a real pinned model actually clears these thresholds across
 * all 50 real cases is a separate question (eval.integration.test.ts's
 * own gated T1/T2/T3) that needs a real ANTHROPIC_API_KEY this sandbox
 * does not have.
 */
import { describe, expect, it } from 'vitest';
import type { Verdict } from '@sentinel/schema';
import { GOLDEN_CASES, buildGoldenCases } from '../eval/golden-cases.js';
import { scoreCase, aggregateResults, checkTolerance, detectDrift, DEFAULT_TOLERANCE, type CaseResult } from '../eval/scoring.js';

const VERDICT: Verdict = {
  severity: 'high',
  title: 'test',
  claims: [{ text: 'x', evidenceRef: ['evt_1'] }],
  attackChain: [],
  recommendedActions: [{ playbook: 'revoke_sessions', urgency: 'now', blastRadius: 'one user' }],
};

describe('GOLDEN_CASES', () => {
  it('AC1: has exactly 50 cases', () => {
    expect(GOLDEN_CASES).toHaveLength(50);
  });

  it('AC1: spans true positives, false positives, and ambiguous situations', () => {
    const categories = new Set(GOLDEN_CASES.map((c) => c.category));
    expect(categories).toEqual(new Set(['true_positive', 'false_positive', 'ambiguous']));
  });

  it('every case has a unique id', () => {
    const ids = new Set(GOLDEN_CASES.map((c) => c.id));
    expect(ids.size).toBe(GOLDEN_CASES.length);
  });

  it('is deterministic — rebuilding produces the identical set of ids', () => {
    expect(buildGoldenCases().map((c) => c.id)).toEqual(GOLDEN_CASES.map((c) => c.id));
  });
});

describe('scoreCase', () => {
  const dismissCase = GOLDEN_CASES.find((c) => c.expectedTriageDisposition === 'dismiss')!;
  const escalateCase = GOLDEN_CASES.find((c) => c.expectedTriageDisposition === 'escalate')!;
  const bypassCase = GOLDEN_CASES.find((c) => c.expectedTriageDisposition === 'bypass_critical')!;

  it('T3: a correctly dismissed false-positive case passes without needing a verdict at all', () => {
    const result: CaseResult = { caseId: dismissCase.id, triageDisposition: 'dismiss' };
    const score = scoreCase(dismissCase, result);
    expect(score.overallPass).toBe(true);
    expect(score.severityCorrect).toBeNull();
  });

  it('a case expected to escalate but dismissed instead fails', () => {
    const result: CaseResult = { caseId: escalateCase.id, triageDisposition: 'dismiss' };
    const score = scoreCase(escalateCase, result);
    expect(score.triageCorrect).toBe(false);
    expect(score.overallPass).toBe(false);
  });

  it('a correctly escalated, grounded, appropriately-actioned case passes', () => {
    const result: CaseResult = { caseId: escalateCase.id, triageDisposition: 'escalate', verdict: VERDICT, groundingPassed: true };
    const score = scoreCase(escalateCase, result);
    expect(score.overallPass).toBe(true);
  });

  it('a case whose grounding failed is never an overall pass, regardless of severity/action correctness', () => {
    const result: CaseResult = { caseId: bypassCase.id, triageDisposition: 'bypass_critical', verdict: VERDICT, groundingPassed: false };
    const score = scoreCase(bypassCase, result);
    expect(score.groundingPassed).toBe(false);
    expect(score.overallPass).toBe(false);
  });

  it('a pipeline error is scored as a failure, distinct from a wrong-but-valid answer', () => {
    const result: CaseResult = { caseId: escalateCase.id, triageDisposition: 'escalate', error: 'model timed out' };
    const score = scoreCase(escalateCase, result);
    expect(score.overallPass).toBe(false);
    expect(score.failureReasons[0]).toContain('pipeline error');
  });

  it('an inappropriate action (no match in expectedPlaybooksAnyOf) fails even with correct severity and grounding', () => {
    const wrongActionVerdict: Verdict = { ...VERDICT, recommendedActions: [{ playbook: 'block_ip', urgency: 'now', blastRadius: 'n/a' }] };
    const caseWithPlaybooks = GOLDEN_CASES.find((c) => c.expectedPlaybooksAnyOf && !c.expectedPlaybooksAnyOf.includes('block_ip'))!;
    const result: CaseResult = { caseId: caseWithPlaybooks.id, triageDisposition: caseWithPlaybooks.expectedTriageDisposition as 'escalate', verdict: wrongActionVerdict, groundingPassed: true };
    const score = scoreCase(caseWithPlaybooks, result);
    expect(score.actionAppropriate).toBe(false);
    expect(score.overallPass).toBe(false);
  });
});

describe('aggregateResults / checkTolerance', () => {
  it('a perfect run passes every tolerance threshold', () => {
    const scores = GOLDEN_CASES.map((c) =>
      scoreCase(c, c.expectedTriageDisposition === 'dismiss' ? { caseId: c.id, triageDisposition: 'dismiss' } : { caseId: c.id, triageDisposition: c.expectedTriageDisposition as 'escalate', verdict: VERDICT, groundingPassed: true }),
    );
    const result = aggregateResults(scores);
    expect(result.totalCases).toBe(50);
    expect(checkTolerance(result, DEFAULT_TOLERANCE).pass).toBe(true);
  });

  it('T4: a deliberately degraded model (every case dismissed) fails the suite\'s own tolerance', () => {
    const scores = GOLDEN_CASES.map((c) => scoreCase(c, { caseId: c.id, triageDisposition: 'dismiss' }));
    const result = aggregateResults(scores);
    const check = checkTolerance(result, DEFAULT_TOLERANCE);
    expect(check.pass).toBe(false);
    expect(check.failures.length).toBeGreaterThan(0);
  });
});

describe('detectDrift', () => {
  it('passes when the current run matches or improves on the previous one', () => {
    const previous = aggregateResults([]);
    const current = { ...previous, triageAccuracy: 0.95, severityAccuracy: 0.9, groundingCompleteness: 1, actionAppropriateness: 0.9 };
    expect(detectDrift(current, { ...previous, triageAccuracy: 0.9, severityAccuracy: 0.85, groundingCompleteness: 1, actionAppropriateness: 0.85 }).pass).toBe(true);
  });

  it('fails when a metric drops more than the allowed amount since the last run, even if still above the absolute tolerance floor', () => {
    const previous = { ...aggregateResults([]), severityAccuracy: 0.95 };
    const current = { ...previous, severityAccuracy: 0.86 }; // still above DEFAULT_TOLERANCE's 0.85 floor, but a 9-point drop
    expect(detectDrift(current, previous, 0.05).pass).toBe(false);
  });
});
