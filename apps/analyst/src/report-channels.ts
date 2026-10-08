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
  const items = actions.map((a) => `<li style="margin: 0 0 4px;">${escapeHtml(a.plainDescription)} (${escapeHtml(a.blastRadius)})</li>`).join('');
  return `<ul style="margin: 0; padding-left: 20px;">${items}</ul>`;
}

const EMAIL_FONT_STYLE = "font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 14px; line-height: 1.5;";

/** One full-width table row, mirroring a `<section>` — Outlook's own
 * rendering engine (Word, not a browser engine) does not reliably
 * apply CSS from a `<style>` block or respect flexbox/grid/margin
 * shorthand; `<table>`/`<tr>`/`<td>` layout with every rule INLINE is
 * the one approach every major client (Outlook, Gmail, Apple Mail)
 * has rendered consistently for two decades, which is the actual
 * reason AC2 asks for it, not a stylistic preference. */
function emailSectionRow(innerHtml: string): string {
  return `<tr><td style="padding: 12px 24px; ${EMAIL_FONT_STYLE}">${innerHtml}</td></tr>`;
}

/**
 * Well-formed, table-based, inline-styled HTML (AC2 — Outlook
 * compatibility) — every piece of report text is escaped (AC3's own
 * evidence ultimately traces back to model-authored claim text; even
 * though P4-03/P4-04 already validated its SHAPE and GROUNDING, it is
 * still untrusted for HTML-ENCODING purposes, the same way any
 * user-controlled string would be before it reaches a browser).
 */
export function renderForEmail(report: Report): string {
  const rows = [
    emailSectionRow(`<h1 style="margin: 0; font-size: 18px;">${escapeHtml(report.title)}</h1>`),
    report.whatHappened ? emailSectionRow(`<h2 style="margin: 0 0 6px; font-size: 15px;">What happened</h2><p style="margin: 0;">${escapeHtml(report.whatHappened)}</p>`) : '',
    report.whyItMatters ? emailSectionRow(`<h2 style="margin: 0 0 6px; font-size: 15px;">Why it matters</h2><p style="margin: 0;">${escapeHtml(report.whyItMatters)}</p>`) : '',
    report.actionsNow.length ? emailSectionRow(`<h2 style="margin: 0 0 6px; font-size: 15px;">Do now</h2>${htmlActionList(report.actionsNow)}`) : '',
    report.actionsToday.length ? emailSectionRow(`<h2 style="margin: 0 0 6px; font-size: 15px;">Do today</h2>${htmlActionList(report.actionsToday)}`) : '',
    report.actionsLater.length ? emailSectionRow(`<h2 style="margin: 0 0 6px; font-size: 15px;">Do later</h2>${htmlActionList(report.actionsLater)}`) : '',
  ].join('');

  return [
    '<!doctype html>',
    '<html>',
    '<body style="margin: 0; padding: 0; background-color: #f4f4f4;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f4;"><tr><td align="center" style="padding: 24px 0;">',
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; ${EMAIL_FONT_STYLE}">`,
    rows,
    '</table>',
    '</td></tr></table>',
    '</body>',
    '</html>',
  ].join('');
}

function plainTextActionList(actions: Report['actionsNow']): string {
  return actions.map((a) => `  - ${a.plainDescription} (${a.blastRadius})`).join('\n');
}

/**
 * AC5: "a plain-text alternative is always included" — email's own
 * multipart/alternative convention, for a client that can't or won't
 * render HTML, and for spam filters that weight a missing text part
 * against deliverability (part of why AC1's authentication alone is
 * not sufficient on its own).
 */
export function renderPlainTextForEmail(report: Report): string {
  const parts = [
    report.title,
    report.whatHappened ? `What happened\n${report.whatHappened}` : '',
    report.whyItMatters ? `Why it matters\n${report.whyItMatters}` : '',
    report.actionsNow.length ? `Do now\n${plainTextActionList(report.actionsNow)}` : '',
    report.actionsToday.length ? `Do today\n${plainTextActionList(report.actionsToday)}` : '',
    report.actionsLater.length ? `Do later\n${plainTextActionList(report.actionsLater)}` : '',
  ].filter(Boolean);
  return parts.join('\n\n');
}

/** The dashboard consumes the already-structured Report directly — no
 * further transform needed, since it renders its own UI from the data
 * rather than from pre-formatted text/markup the way the other three
 * channels do. */
export function renderForDashboard(report: Report): Report {
  return report;
}
