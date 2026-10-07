/**
 * P4-07 AC4: "reports render correctly in WhatsApp, Slack, email and
 * the dashboard." Each renderer is a pure function of `Report` ->
 * that channel's own wire format, respecting that channel's own real
 * limits (WhatsApp's message length, Slack's block/text limits) rather
 * than assuming a short report always fits.
 */
import type { Report } from './report.js';

/** WhatsApp's own text-message cap (Meta Cloud API). A report that
 * would exceed it is truncated with an explicit marker — the same
 * "never silently cut" discipline this codebase already applies to an
 * oversized tool result (P4-02's own `truncate` helper). */
export const WHATSAPP_MAX_CHARS = 4096;

function section(title: string, body: string): string {
  return body ? `*${title}*\n${body}\n` : '';
}

function actionLines(actions: Report['actionsNow']): string {
  return actions.map((a) => `• ${a.plainDescription} (${a.blastRadius})`).join('\n');
}

export function renderForWhatsApp(report: Report): string {
  const parts = [
    `*${report.title}*`,
    section('What happened', report.whatHappened),
    section('Why it matters', report.whyItMatters),
    section('Do now', actionLines(report.actionsNow)),
    section('Do today', actionLines(report.actionsToday)),
    section('Do later', actionLines(report.actionsLater)),
  ].filter(Boolean);
  const text = parts.join('\n');
  if (text.length <= WHATSAPP_MAX_CHARS) return text;
  const marker = '\n…(truncated — see the dashboard for the full report)';
  return text.slice(0, WHATSAPP_MAX_CHARS - marker.length) + marker;
}

/** Slack Block Kit. A `section` block's own `text.text` field is
 * capped at 3000 characters (Slack's real limit) — truncated the same
 * explicit way WhatsApp's own cap is handled above, never silently. */
export const SLACK_SECTION_TEXT_MAX_CHARS = 3000;

interface SlackBlock {
  type: 'section' | 'divider';
  text?: { type: 'mrkdwn'; text: string };
}

function slackSection(markdown: string): SlackBlock {
  const text = markdown.length <= SLACK_SECTION_TEXT_MAX_CHARS ? markdown : markdown.slice(0, SLACK_SECTION_TEXT_MAX_CHARS - 1) + '…';
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

export function renderForSlack(report: Report): { blocks: SlackBlock[] } {
  const blocks: SlackBlock[] = [slackSection(`*${report.title}*`)];
  if (report.whatHappened) blocks.push(slackSection(`*What happened*\n${report.whatHappened}`));
  if (report.whyItMatters) blocks.push(slackSection(`*Why it matters*\n${report.whyItMatters}`));
  blocks.push({ type: 'divider' });
  for (const [label, actions] of [
    ['Do now', report.actionsNow],
    ['Do today', report.actionsToday],
    ['Do later', report.actionsLater],
  ] as const) {
    if (actions.length > 0) blocks.push(slackSection(`*${label}*\n${actionLines(actions)}`));
  }
  return { blocks };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlActionList(actions: Report['actionsNow']): string {
  if (actions.length === 0) return '';
  return `<ul>${actions.map((a) => `<li>${escapeHtml(a.plainDescription)} (${escapeHtml(a.blastRadius)})</li>`).join('')}</ul>`;
}

/**
 * Plain, well-formed HTML — every piece of report text is escaped
 * (AC3's own evidence ultimately traces back to model-authored claim
 * text; even though P4-03/P4-04 already validated its SHAPE and
 * GROUNDING, it is still untrusted for HTML-ENCODING purposes, the
 * same way any user-controlled string would be before it reaches a
 * browser).
 */
export function renderForEmail(report: Report): string {
  return [
    '<!doctype html><html><body>',
    `<h1>${escapeHtml(report.title)}</h1>`,
    report.whatHappened ? `<h2>What happened</h2><p>${escapeHtml(report.whatHappened)}</p>` : '',
    report.whyItMatters ? `<h2>Why it matters</h2><p>${escapeHtml(report.whyItMatters)}</p>` : '',
    report.actionsNow.length ? `<h2>Do now</h2>${htmlActionList(report.actionsNow)}` : '',
    report.actionsToday.length ? `<h2>Do today</h2>${htmlActionList(report.actionsToday)}` : '',
    report.actionsLater.length ? `<h2>Do later</h2>${htmlActionList(report.actionsLater)}` : '',
    '</body></html>',
  ].join('');
}

/** The dashboard consumes the already-structured Report directly — no
 * further transform needed, since it renders its own UI from the data
 * rather than from pre-formatted text/markup the way the other three
 * channels do. */
export function renderForDashboard(report: Report): Report {
  return report;
}
