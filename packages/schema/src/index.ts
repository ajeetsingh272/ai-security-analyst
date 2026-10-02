/**
 * Shared contracts. Defined ONCE here and code-generated into Go (ADR-0001),
 * so the TypeScript product plane and the Go data plane cannot disagree about
 * what a Case is. A drift becomes a compile error rather than a 3am page.
 *
 * Implemented by P0-11.
 */

export const SCHEMA_VERSION = '0.1.0';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type CaseState =
  | 'open'
  | 'triaging'
  | 'investigating'
  | 'awaiting_approval'
  | 'actioned'
  | 'closed'
  | 'dismissed';

/**
 * A single assertion in an AI-generated report.
 *
 * `evidenceRef` is not decorative. Before a report reaches a customer, the
 * grounding validator (P4-04) re-queries the event store for every id listed
 * here, scoped to the case's tenant. One unresolvable reference fails the whole
 * report. This field is the mechanism behind trust guarantee TG1.
 */
export interface Claim {
  text: string;
  evidenceRef: string[];
}

export interface Verdict {
  severity: Severity;
  title: string;
  claims: Claim[];
  attackChain: string[];
  recommendedActions: RecommendedAction[];
}

export interface RecommendedAction {
  playbook: string;
  urgency: 'now' | 'today' | 'later';
  blastRadius: string;
}
