/**
 * P4-07 T4 — each channel renderer against a real generated Report,
 * including one deliberately oversized to prove truncation is
 * explicit, never silent (the same discipline P4-02's own `truncate`
 * helper established for an oversized tool result).
 */
import { describe, expect, it } from 'vitest';
import type { Verdict } from '@sentinel/schema';
import { generateReport } from '../report.js';
import { renderForWhatsApp, renderForSlack, renderForEmail, renderForDashboard, WHATSAPP_MAX_CHARS, SLACK_SECTION_TEXT_MAX_CHARS } from '../report-channels.js';

const VERDICT: Verdict = {
  severity: 'critical',
  title: 'Suspected email account compromise',
  claims: [{ text: "Someone signed in from Russia and copied her messages via an inbox rule.", evidenceRef: ['evt_1'] }],
  attackChain: ['T1078'],
  recommendedActions: [
    { playbook: 'revoke_sessions', urgency: 'now', blastRadius: 'One identity.' },
    { playbook: 'delete_inbox_rule', urgency: 'today', blastRadius: 'One mailbox rule.' },
  ],
};

describe('T4: report renders without layout breakage in all four channels', () => {
  it('WhatsApp: a normal report renders as plain text within the character limit', () => {
    const text = renderForWhatsApp(generateReport(VERDICT));
    expect(text.length).toBeLessThanOrEqual(WHATSAPP_MAX_CHARS);
    expect(text).toContain(VERDICT.title);
  });

  it('WhatsApp: an oversized report is truncated with an explicit marker, never silently cut', () => {
    const hugeVerdict: Verdict = { ...VERDICT, claims: [{ text: 'x '.repeat(5000), evidenceRef: ['evt_1'] }] };
    const text = renderForWhatsApp(generateReport(hugeVerdict));
    expect(text.length).toBeLessThanOrEqual(WHATSAPP_MAX_CHARS);
    expect(text).toContain('truncated');
  });

  it('Slack: produces valid Block Kit JSON with each section under the text limit', () => {
    const { blocks } = renderForSlack(generateReport(VERDICT));
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      if (block.text) expect(block.text.text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_MAX_CHARS);
    }
  });

  it('Slack: an oversized section is truncated, never silently cut', () => {
    const hugeVerdict: Verdict = { ...VERDICT, claims: [{ text: 'y '.repeat(2000), evidenceRef: ['evt_1'] }] };
    const { blocks } = renderForSlack(generateReport(hugeVerdict));
    const whatHappenedBlock = blocks.find((b) => b.text?.text.includes('What happened'));
    expect(whatHappenedBlock?.text?.text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_MAX_CHARS);
  });

  it('Email: produces well-formed, balanced HTML with every tag closed', () => {
    const html = renderForEmail(generateReport(VERDICT));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    const openTags = html.match(/<(h1|h2|p|ul|li|body|html)(?:\s[^>]*)?>/g) ?? [];
    const closeTags = html.match(/<\/(h1|h2|p|ul|li|body|html)>/g) ?? [];
    expect(openTags.length).toBe(closeTags.length);
  });

  it('Email: escapes HTML-significant characters in model-authored text, preventing injection', () => {
    const verdictWithHtml: Verdict = {
      ...VERDICT,
      title: '<script>alert(1)</script>',
    };
    const html = renderForEmail(generateReport(verdictWithHtml));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('Dashboard: returns the structured report as-is, for the UI to render its own layout', () => {
    const report = generateReport(VERDICT);
    expect(renderForDashboard(report)).toBe(report);
  });
});
