/**
 * P4-07 T1/T2/T3 — generateReport against a well-formed, already-
 * grounded Verdict (no model, no database: report generation is pure
 * presentation over data P4-03/P4-04 already validated).
 */
import { describe, expect, it } from 'vitest';
import type { Verdict } from '@sentinel/schema';
import { generateReport } from '../report.js';
import { isReadable } from '../readability.js';
import { findUnglossedJargon } from '../jargon.js';

/** T3: the ticket's own brief, reconstructed as the grounded Verdict a
 * real investigation would plausibly produce for it — report.ts's job
 * is only to gloss and restructure this, never to invent the
 * "fraud preparation" characterization itself; that comes from the
 * verdict's own (already-validated) title, the same way every other
 * sentence in the report traces back to already-grounded content. */
const BEC_GOLDEN_VERDICT: Verdict = {
  severity: 'critical',
  title: 'Suspected email account compromise and fraud preparation',
  claims: [
    {
      text: "Someone signed in to Priya's email account from Russia. She has never signed in from there before.",
      evidenceRef: ['evt_signin_1'],
    },
    {
      text: 'Right after that, an inbox rule was set up that copies her incoming messages to an outside address. She was never told about it.',
      evidenceRef: ['evt_rule_1'],
    },
  ],
  attackChain: ['T1078', 'T1114.003'],
  recommendedActions: [
    { playbook: 'revoke_sessions', urgency: 'now', blastRadius: 'One identity: all active sessions dropped, password reset required at next sign-in.' },
    { playbook: 'delete_inbox_rule', urgency: 'now', blastRadius: 'Removes the forwarding rule; no further messages are copied out.' },
  ],
};

describe('generateReport', () => {
  it('AC2: states what happened, why it matters, and what to do now/today/later', () => {
    const report = generateReport(BEC_GOLDEN_VERDICT);
    expect(report.whatHappened.length).toBeGreaterThan(0);
    expect(report.whyItMatters.length).toBeGreaterThan(0);
    expect(report.actionsNow.length).toBeGreaterThan(0);
  });

  it('AC3: every evidence entry maps back to one of the verdict\'s own claims', () => {
    const report = generateReport(BEC_GOLDEN_VERDICT);
    expect(report.evidence).toHaveLength(BEC_GOLDEN_VERDICT.claims.length);
    expect(report.evidence[0]!.evidenceRef).toEqual(['evt_signin_1']);
    expect(report.evidence[1]!.evidenceRef).toEqual(['evt_rule_1']);
  });

  it('T1: the generated report passes the readability threshold', () => {
    const report = generateReport(BEC_GOLDEN_VERDICT);
    expect(isReadable(`${report.whatHappened} ${report.whyItMatters}`)).toBe(true);
  });

  it('T2: the jargon detector finds no unglossed term in the generated report', () => {
    const report = generateReport(BEC_GOLDEN_VERDICT);
    const fullText = [report.title, report.whatHappened, report.whyItMatters].join(' ');
    expect(findUnglossedJargon(fullText)).toEqual([]);
  });

  it('T3: the BEC golden case produces a report materially equivalent to the brief\'s example', () => {
    const report = generateReport(BEC_GOLDEN_VERDICT);
    // The brief: "Someone in Russia has opened Priya's email account and
    // is secretly copying her messages. This looks like fraud preparation."
    expect(report.whatHappened).toContain('Russia');
    expect(report.whatHappened.toLowerCase()).toMatch(/forward|cop(y|ies|ied)/);
    expect(report.whyItMatters.toLowerCase()).toContain('fraud preparation');
  });

  it("falls back to the raw playbook identifier for an unknown playbook, never fabricating a description", () => {
    const verdict: Verdict = { ...BEC_GOLDEN_VERDICT, recommendedActions: [{ playbook: 'made_up_playbook', urgency: 'later', blastRadius: 'unknown' }] };
    const report = generateReport(verdict);
    expect(report.actionsLater[0]!.plainDescription).toBe('made_up_playbook');
  });
});
