/**
 * P4-07: plain-English report generation from an ALREADY schema-valid,
 * ALREADY grounded Verdict (P4-03/P4-04) — this file never calls a
 * model again and never invents content. Every sentence in the
 * generated report traces back to one of the verdict's own validated
 * claims or fields (AC3); this is purely deterministic presentation —
 * jargon-glossing and restructuring what already passed grounding —
 * the same "deterministic code, never a model self-check" discipline
 * P4-04's own grounding validator applies to VALIDATING a report,
 * applied here to WRITING one instead.
 */
import type { Verdict, Severity, RecommendedAction } from '@sentinel/schema';
import { glossJargon } from './jargon.js';
import { isKnownPlaybook, type PlaybookId } from './playbook-registry.js';

const SEVERITY_PLAIN: Record<Severity, string> = {
  critical: 'critical — needs attention right now',
  high: 'high — needs attention today',
  medium: 'medium — worth addressing soon',
  low: 'low — minor, no immediate risk',
  info: 'informational — nothing to act on',
};

/** Plain-English descriptions for P4-03's own known-playbook registry.
 * An unrecognised playbook (should never happen past P4-03's own
 * validation, but this file does not re-trust that) falls back to its
 * raw identifier rather than fabricating a description. */
const PLAYBOOK_PLAIN: Record<PlaybookId, string> = {
  disable_user: 'disable this user account',
  revoke_sessions: 'sign this user out of every active session',
  delete_inbox_rule: 'remove the automatic mailbox rule that was created',
  block_ip: 'block network access from this address',
  force_password_reset: 'require a new password before the account can be used again',
  isolate_device: 'disconnect this device from the network',
};

export interface ReportAction {
  playbook: string;
  plainDescription: string;
  blastRadius: string;
}

export interface EvidenceEntry {
  statement: string;
  evidenceRef: string[];
}

export interface Report {
  title: string;
  whatHappened: string;
  whyItMatters: string;
  actionsNow: ReportAction[];
  actionsToday: ReportAction[];
  actionsLater: ReportAction[];
  /** AC3: "every statement maps to a validated claim with its evidence
   * visible on demand" — not narrated inline (that would clutter the
   * plain-English text itself), but always present alongside it. */
  evidence: EvidenceEntry[];
}

function plainAction(action: RecommendedAction): ReportAction {
  const plainDescription = isKnownPlaybook(action.playbook) ? PLAYBOOK_PLAIN[action.playbook] : action.playbook;
  return { playbook: action.playbook, plainDescription, blastRadius: action.blastRadius };
}

export function generateReport(verdict: Verdict): Report {
  const whatHappened = glossJargon(verdict.claims.map((c) => c.text).join(' '));
  const whyItMatters = glossJargon(`${verdict.title}. This case is rated ${SEVERITY_PLAIN[verdict.severity]}.`);

  return {
    title: glossJargon(verdict.title),
    whatHappened,
    whyItMatters,
    actionsNow: verdict.recommendedActions.filter((a) => a.urgency === 'now').map(plainAction),
    actionsToday: verdict.recommendedActions.filter((a) => a.urgency === 'today').map(plainAction),
    actionsLater: verdict.recommendedActions.filter((a) => a.urgency === 'later').map(plainAction),
    evidence: verdict.claims.map((c) => ({ statement: glossJargon(c.text), evidenceRef: c.evidenceRef })),
  };
}
