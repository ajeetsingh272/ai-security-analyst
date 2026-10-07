/**
 * P4-03: real validation of a model's output against the Verdict
 * contract (packages/schema, P3-08/P0-11's frozen shape) — replacing
 * P4-01's own placeholder `isVerdictShaped` duck-type check with
 * something that can actually explain WHAT is wrong, which is what the
 * one-repair-attempt flow (investigation-model.ts) needs to tell the
 * model to fix.
 *
 * Deliberately NOT the grounding validator (P4-04) — this checks the
 * verdict's own SHAPE (is severity one of the five values, does every
 * claim have at least one evidence reference, is every recommended
 * playbook a real, known identifier), not whether a `evidenceRef` id
 * actually resolves to a real event. That re-query against the event
 * store, scoped to the case's tenant, is P4-04's own job.
 */
import type { Verdict, Severity, Urgency } from '@sentinel/schema';
import { isKnownPlaybook } from './playbook-registry.js';

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const URGENCIES: readonly Urgency[] = ['now', 'today', 'later'];

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type VerdictValidationResult = { ok: true; verdict: Verdict } | { ok: false; errors: ValidationError[] };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * AC1/AC3/AC4/AC5: covers severity's enumeration, each claim's non-empty
 * evidenceRef (T4), and each recommended action's playbook against the
 * registry (T3) — every structural AC in one pass, so the repair prompt
 * can report every problem at once rather than one round-trip per field.
 */
export function validateVerdict(value: unknown): VerdictValidationResult {
  const errors: ValidationError[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: [{ path: '$', message: 'must be a JSON object' }] };
  }
  const v = value as Record<string, unknown>;

  if (!SEVERITIES.includes(v.severity as Severity)) {
    errors.push({ path: 'severity', message: `must be one of ${SEVERITIES.join(', ')}, got ${JSON.stringify(v.severity)}` });
  }
  if (!isNonEmptyString(v.title)) {
    errors.push({ path: 'title', message: 'must be a non-empty string' });
  }

  if (!Array.isArray(v.claims)) {
    errors.push({ path: 'claims', message: 'must be an array' });
  } else {
    v.claims.forEach((claim, i) => {
      if (typeof claim !== 'object' || claim === null) {
        errors.push({ path: `claims[${i}]`, message: 'must be an object' });
        return;
      }
      const c = claim as Record<string, unknown>;
      if (!isNonEmptyString(c.text)) {
        errors.push({ path: `claims[${i}].text`, message: 'must be a non-empty string' });
      }
      // T4: a claim with NO evidence is unverifiable and must be
      // rejected here, before the grounding validator (P4-04) would
      // otherwise have to re-query the event store for nothing.
      if (!Array.isArray(c.evidenceRef) || c.evidenceRef.length === 0 || !c.evidenceRef.every(isNonEmptyString)) {
        errors.push({ path: `claims[${i}].evidenceRef`, message: 'must be a non-empty array of non-empty strings' });
      }
    });
  }

  if (!Array.isArray(v.attackChain) || !v.attackChain.every((t) => typeof t === 'string')) {
    errors.push({ path: 'attackChain', message: 'must be an array of strings' });
  }

  if (!Array.isArray(v.recommendedActions)) {
    errors.push({ path: 'recommendedActions', message: 'must be an array' });
  } else {
    v.recommendedActions.forEach((action, i) => {
      if (typeof action !== 'object' || action === null) {
        errors.push({ path: `recommendedActions[${i}]`, message: 'must be an object' });
        return;
      }
      const a = action as Record<string, unknown>;
      // T3: a playbook identifier the registry doesn't know is not a
      // smaller problem than a malformed field — an unactionable or
      // made-up action is exactly what AC4 exists to catch.
      if (typeof a.playbook !== 'string' || !isKnownPlaybook(a.playbook)) {
        errors.push({ path: `recommendedActions[${i}].playbook`, message: `unknown playbook ${JSON.stringify(a.playbook)}` });
      }
      if (!URGENCIES.includes(a.urgency as Urgency)) {
        errors.push({ path: `recommendedActions[${i}].urgency`, message: `must be one of ${URGENCIES.join(', ')}` });
      }
      if (!isNonEmptyString(a.blastRadius)) {
        errors.push({ path: `recommendedActions[${i}].blastRadius`, message: 'must be a non-empty string' });
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, verdict: value as Verdict };
}

export function formatValidationErrors(errors: readonly ValidationError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join('; ');
}
