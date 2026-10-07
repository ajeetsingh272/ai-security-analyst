/**
 * P4-11 AC5: "diffing two replays of the same case is supported" — a
 * pure, structural comparison of two Verdicts. Claims are matched by
 * their own text (not position), since a model reordering identical
 * claims across two replays is not a meaningful difference worth
 * surfacing; actions are matched by playbook+urgency for the same
 * reason.
 */
import type { Verdict, Claim, RecommendedAction } from '@sentinel/schema';

export interface VerdictDiff {
  severityChanged: boolean;
  from: { severity: string; title: string };
  to: { severity: string; title: string };
  titleChanged: boolean;
  claimsAdded: Claim[];
  claimsRemoved: Claim[];
  actionsAdded: RecommendedAction[];
  actionsRemoved: RecommendedAction[];
  /** True when nothing a human would call "a different answer"
   * changed — the two replays agree in substance. */
  materiallyEquivalent: boolean;
}

function actionKey(a: RecommendedAction): string {
  return `${a.playbook}:${a.urgency}`;
}

export function diffVerdicts(from: Verdict, to: Verdict): VerdictDiff {
  const fromClaimTexts = new Set(from.claims.map((c) => c.text));
  const toClaimTexts = new Set(to.claims.map((c) => c.text));
  const claimsAdded = to.claims.filter((c) => !fromClaimTexts.has(c.text));
  const claimsRemoved = from.claims.filter((c) => !toClaimTexts.has(c.text));

  const fromActionKeys = new Set(from.recommendedActions.map(actionKey));
  const toActionKeys = new Set(to.recommendedActions.map(actionKey));
  const actionsAdded = to.recommendedActions.filter((a) => !fromActionKeys.has(actionKey(a)));
  const actionsRemoved = from.recommendedActions.filter((a) => !toActionKeys.has(actionKey(a)));

  const severityChanged = from.severity !== to.severity;
  const titleChanged = from.title !== to.title;

  return {
    severityChanged,
    from: { severity: from.severity, title: from.title },
    to: { severity: to.severity, title: to.title },
    titleChanged,
    claimsAdded,
    claimsRemoved,
    actionsAdded,
    actionsRemoved,
    materiallyEquivalent: !severityChanged && claimsAdded.length === 0 && claimsRemoved.length === 0 && actionsAdded.length === 0 && actionsRemoved.length === 0,
  };
}
