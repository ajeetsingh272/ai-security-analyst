/**
 * P6-07: rendering the weekly report for its three delivery surfaces —
 * email (HTML + required plain text, same AC5-style requirement
 * email-channel.ts already enforces at the type level), the dashboard
 * copy (plain data, rendered by the frontend), and the PDF export.
 *
 * Deliberately NOT a reuse of apps/analyst/src/report-channels.ts's
 * renderers — those are shaped around a case alert's Verdict/claims/
 * evidence, a different structure than this weekly digest, and
 * apps/analyst is a separate deployable process apps/api cannot import
 * from anyway (same constraint as readability.ts before its own
 * promotion to @sentinel/readability).
 */
import { chromium } from 'playwright-core';
import type { WeeklyReportRow } from '@sentinel/db';
import type { WeeklyReportData } from './weekly-report.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function reportHtml(report: WeeklyReportRow, tenantName: string): string {
  const data = report.data as WeeklyReportData;
  const severityRows = Object.entries(data.bySeverity)
    .map(([sev, count]) => `<tr><td style="padding:4px 12px;">${escapeHtml(sev)}</td><td style="padding:4px 12px;">${count}</td></tr>`)
    .join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Weekly report — ${escapeHtml(tenantName)}</title></head>
<body style="font-family: -apple-system, Arial, sans-serif; color: #1a1a1a; max-width: 680px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px;">${escapeHtml(tenantName)} — weekly security summary</h1>
  <p style="color:#666; font-size: 13px;">${new Date(report.windowStart).toLocaleDateString()} – ${new Date(report.windowEnd).toLocaleDateString()}</p>
  <p style="font-size: 16px; font-weight: 600;">${escapeHtml(report.headline)}</p>
  ${severityRows ? `<table style="border-collapse:collapse; margin: 16px 0;"><tbody>${severityRows}</tbody></table>` : ''}
  ${
    report.oneImprovement
      ? `<div style="background:#fff3cd; border:1px solid #ffe69c; border-radius:6px; padding:12px; margin: 16px 0;">
           <strong>One thing to improve:</strong> ${escapeHtml(report.oneImprovement)}
         </div>`
      : ''
  }
</body></html>`;
}

function reportPlainText(report: WeeklyReportRow, tenantName: string): string {
  const data = report.data as WeeklyReportData;
  const lines = [
    `${tenantName} — weekly security summary`,
    `${new Date(report.windowStart).toLocaleDateString()} - ${new Date(report.windowEnd).toLocaleDateString()}`,
    '',
    report.headline,
    '',
  ];
  for (const [sev, count] of Object.entries(data.bySeverity)) lines.push(`${sev}: ${count}`);
  if (report.oneImprovement) lines.push('', `One thing to improve: ${report.oneImprovement}`);
  return lines.join('\n');
}

export function renderWeeklyReportEmail(report: WeeklyReportRow, tenantName: string): { html: string; text: string } {
  return { html: reportHtml(report, tenantName), text: reportPlainText(report, tenantName) };
}

/** T3: a real headless-Chromium PDF render of the same HTML the email
 * ships — not a second, separately-maintained PDF template. */
export async function renderWeeklyReportPdf(report: WeeklyReportRow, tenantName: string): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(reportHtml(report, tenantName), { waitUntil: 'load' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
