/**
 * P4-08: pure scoring logic for the golden-case eval suite — separated
 * from `runner.ts`'s own real-infra execution the same way
 * services/correlate/internal/baseline splits pure `evaluate` from its
 * ClickHouse-aware `store.go` shell. Every function here is testable
 * with zero real infra and zero Anthropic API key, which is also why
 * these are the functions this ticket's OWN unit tests exercise
 * directly, rather than only through a full suite run.
 */
import type { Severity, Verdict } from '@sentinel/schema';
import type { GoldenCase, ExpectedTriageDisposition } from './golden-cases.js';

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

function meetsMinSeverity(actual: Severity, min: Severity): boolean {
  return SEVERITY_RANK[actual] >= SEVERITY_RANK[min];
}

export interface CaseResult {
  caseId: string;
  triageDisposition: ExpectedTriageDisposition;
  /** Present only when the case was NOT dismissed at triage. */
  verdict?: Verdict;
  /** AC2's own "100% grounding" — whether every evidenceRef resolved,
   * per P4-04's own grounding validator. Present only alongside a
   * verdict. */
  groundingPassed?: boolean;
  /** A pipeline error (not a scoring failure) — e.g. the model never
   * produced a parseable verdict at all. Tracked separately so a
   * crash and a wrong-but-valid answer are never confused in the
   * aggregate numbers. */
  error?: string;
}

export interface CaseScore {
  caseId: string;
  category: GoldenCase['category'];
  triageCorrect: boolean;
  /** null when the case was correctly dismissed/bypassed and severity
   * accuracy does not apply to it at all — distinct from false, which
   * means "escalated and WRONG." */
  severityCorrect: boolean | null;
  groundingPassed: boolean | null;
  actionAppropriate: boolean | null;
  overallPass: boolean;
  failureReasons: string[];
}

/** AC2: "severity accuracy, 100% grounding, and recommended-action
 * appropriateness" — one function, scoring all three for one case,
 * so a single golden case's own result is judged consistently
 * regardless of which aggregate statistic later reads it. */
export function scoreCase(goldenCase: GoldenCase, result: CaseResult): CaseScore {
  const failureReasons: string[] = [];

  if (result.error) {
    return {
      caseId: goldenCase.id,
      category: goldenCase.category,
      triageCorrect: false,
      severityCorrect: null,
      groundingPassed: null,
      actionAppropriate: null,
      overallPass: false,
      failureReasons: [`pipeline error: ${result.error}`],
    };
  }

  const triageCorrect = result.triageDisposition === goldenCase.expectedTriageDisposition;
  if (!triageCorrect) {
    failureReasons.push(`expected triage disposition "${goldenCase.expectedTriageDisposition}", got "${result.triageDisposition}"`);
  }

  // T3: a dismissed/bypassed case never reaches severity/grounding/
  // action scoring at all — there is no verdict to score.
  if (goldenCase.expectedTriageDisposition === 'dismiss') {
    return {
      caseId: goldenCase.id,
      category: goldenCase.category,
      triageCorrect,
      severityCorrect: null,
      groundingPassed: null,
      actionAppropriate: null,
      overallPass: triageCorrect,
      failureReasons,
    };
  }

  if (!result.verdict) {
    failureReasons.push('expected an escalated verdict but none was produced');
    return {
      caseId: goldenCase.id,
      category: goldenCase.category,
      triageCorrect,
      severityCorrect: false,
      groundingPassed: false,
      actionAppropriate: false,
      overallPass: false,
      failureReasons,
    };
  }

  const severityCorrect = goldenCase.expectedMinSeverity ? meetsMinSeverity(result.verdict.severity, goldenCase.expectedMinSeverity) : true;
  if (!severityCorrect) {
    failureReasons.push(`expected severity >= "${goldenCase.expectedMinSeverity}", got "${result.verdict.severity}"`);
  }

  const groundingPassed = result.groundingPassed ?? false;
  if (!groundingPassed) failureReasons.push('grounding did not pass (not 100%)');

  const actionAppropriate = goldenCase.expectedPlaybooksAnyOf
    ? result.verdict.recommendedActions.some((a) => goldenCase.expectedPlaybooksAnyOf!.includes(a.playbook))
    : true;
  if (!actionAppropriate) {
    failureReasons.push(`no recommended action matched any of [${(goldenCase.expectedPlaybooksAnyOf ?? []).join(', ')}]`);
  }

  return {
    caseId: goldenCase.id,
    category: goldenCase.category,
    triageCorrect,
    severityCorrect,
    groundingPassed,
    actionAppropriate,
    overallPass: triageCorrect && severityCorrect && groundingPassed && actionAppropriate,
    failureReasons,
  };
}

export interface SuiteResult {
  timestamp: string;
  totalCases: number;
  triageAccuracy: number;
  severityAccuracy: number;
  groundingCompleteness: number;
  actionAppropriateness: number;
  overallPassRate: number;
  scores: CaseScore[];
}

function rate(scores: CaseScore[], pick: (s: CaseScore) => boolean | null): number {
  const applicable = scores.filter((s) => pick(s) !== null);
  if (applicable.length === 0) return 1; // vacuously true — nothing to be wrong about
  return applicable.filter((s) => pick(s) === true).length / applicable.length;
}

export function aggregateResults(scores: CaseScore[], now: () => string = () => new Date().toISOString()): SuiteResult {
  return {
    timestamp: now(),
    totalCases: scores.length,
    triageAccuracy: rate(scores, (s) => s.triageCorrect),
    severityAccuracy: rate(scores, (s) => s.severityCorrect),
    groundingCompleteness: rate(scores, (s) => s.groundingPassed),
    actionAppropriateness: rate(scores, (s) => s.actionAppropriate),
    overallPassRate: scores.length === 0 ? 1 : scores.filter((s) => s.overallPass).length / scores.length,
    scores,
  };
}

export interface EvalTolerance {
  minTriageAccuracy: number;
  minSeverityAccuracy: number;
  /** AC2's own "100% grounding" — defaults to 1.0, not a lower
   * tolerance, since a single unresolved reference is TG1's own
   * "fails the whole report," not a statistic to average away. */
  minGroundingCompleteness: number;
  minActionAppropriateness: number;
}

export const DEFAULT_TOLERANCE: EvalTolerance = {
  minTriageAccuracy: 0.9,
  minSeverityAccuracy: 0.85,
  minGroundingCompleteness: 1.0,
  minActionAppropriateness: 0.85,
};

export interface ToleranceCheck {
  pass: boolean;
  failures: string[];
}

/** AC4: "a regression beyond the configured tolerance fails the
 * build" — this is the one function a CI step's own exit code should
 * come from. */
export function checkTolerance(result: SuiteResult, tolerance: EvalTolerance = DEFAULT_TOLERANCE): ToleranceCheck {
  const failures: string[] = [];
  if (result.triageAccuracy < tolerance.minTriageAccuracy) failures.push(`triage accuracy ${result.triageAccuracy} < ${tolerance.minTriageAccuracy}`);
  if (result.severityAccuracy < tolerance.minSeverityAccuracy) failures.push(`severity accuracy ${result.severityAccuracy} < ${tolerance.minSeverityAccuracy}`);
  if (result.groundingCompleteness < tolerance.minGroundingCompleteness) {
    failures.push(`grounding completeness ${result.groundingCompleteness} < ${tolerance.minGroundingCompleteness}`);
  }
  if (result.actionAppropriateness < tolerance.minActionAppropriateness) {
    failures.push(`action appropriateness ${result.actionAppropriateness} < ${tolerance.minActionAppropriateness}`);
  }
  return { pass: failures.length === 0, failures };
}

/** AC5: "results are tracked over time so drift is visible" — a
 * regression relative to the LAST recorded run, distinct from an
 * absolute tolerance floor: a suite could stay above every floor in
 * `DEFAULT_TOLERANCE` while still sliding several points run over run,
 * which this catches and `checkTolerance` alone would not. */
export function detectDrift(current: SuiteResult, previous: SuiteResult, maxDropAllowed = 0.05): ToleranceCheck {
  const failures: string[] = [];
  const metrics: Array<[string, keyof SuiteResult]> = [
    ['triage accuracy', 'triageAccuracy'],
    ['severity accuracy', 'severityAccuracy'],
    ['grounding completeness', 'groundingCompleteness'],
    ['action appropriateness', 'actionAppropriateness'],
  ];
  for (const [label, key] of metrics) {
    const drop = (previous[key] as number) - (current[key] as number);
    if (drop > maxDropAllowed) {
      failures.push(`${label} dropped by ${drop.toFixed(3)} since the last run (${previous[key]} -> ${current[key]}), more than the allowed ${maxDropAllowed}`);
    }
  }
  return { pass: failures.length === 0, failures };
}
