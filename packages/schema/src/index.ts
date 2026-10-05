/**
 * Shared contracts. Defined ONCE here and code-generated into Go (ADR-0001),
 * so the TypeScript product plane and the Go data plane cannot disagree about
 * what a Case is. A drift becomes a compile error rather than a 3am page.
 *
 * ── Compatibility policy (P0-11 AC4) ───────────────────────────────────────
 *
 * SCHEMA_VERSION follows semver, and `scripts/check-compatibility.mjs`
 * enforces what each component means — not as a style guide, as a CI gate:
 *
 *   PATCH — doc comments, internal reordering. No shape change at all.
 *   MINOR — additive only: a new optional field, a new interface, a new
 *           value added to a string-literal union. Existing Go code that
 *           does not know about the addition still compiles and still
 *           round-trips every field it already knew about.
 *   MAJOR — anything else: a field removed or renamed, a field's type
 *           changed, a union value removed, a field that was optional
 *           becoming required. Existing Go code may no longer compile, or
 *           may compile and silently misread the new shape.
 *
 * The check compares the current parse of this file against
 * `schema.snapshot.json` (the shape committed at the last version bump) and
 * classifies the diff. A MAJOR-shaped diff with no MAJOR version bump fails
 * CI (T3) — the version number is a promise about MIGHT HAVE BROKEN, not
 * documentation that can quietly go stale.
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

/** Named rather than inline on RecommendedAction.urgency: the Go generator
 * (packages/schema/scripts/generate-go.mjs) only handles string-literal
 * unions that are their own named type alias — every field value it needs
 * to turn into a Go type is uniform this way, with no special case for a
 * union declared anonymously inline on a single field. */
export type Urgency = 'now' | 'today' | 'later';

export interface RecommendedAction {
  playbook: string;
  urgency: Urgency;
  blastRadius: string;
}
