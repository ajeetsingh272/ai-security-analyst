/**
 * P6-07 T3: "PDF export renders correctly" — a real headless-Chromium
 * render (no mocking of playwright-core), checking the actual PDF
 * magic bytes and a sane nonzero size, mirroring the disposable
 * tmp-pdf-check.mjs script's own successful manual verification
 * during development (since deleted — this is that check, kept).
 */
import { describe, expect, it } from 'vitest';
import type { WeeklyReportRow } from '@sentinel/db';
import { renderWeeklyReportEmail, renderWeeklyReportPdf } from '../weekly-report-render.js';
import type { WeeklyReportData } from '../weekly-report.js';

function fakeReport(overrides: Partial<WeeklyReportRow> = {}): WeeklyReportRow {
  const data: WeeklyReportData = {
    totalCases: 4,
    bySeverity: { high: 1, medium: 3 },
    actionsByStatus: { succeeded: 2, failed: 1 },
    entitiesAffected: 3,
    topCase: { title: 'Suspicious sign-in', severity: 'high' },
  };
  return {
    id: 'report-1',
    tenantId: 'tenant-1',
    windowStart: new Date('2026-09-28T00:00:00Z').toISOString(),
    windowEnd: new Date('2026-10-05T00:00:00Z').toISOString(),
    headline: 'Sentinel caught 1 thing this week that needed attention, and acted on what it could.',
    oneImprovement: "Review the 1 action that didn't complete automatically this week — they may need manual follow-up.",
    isQuiet: false,
    data,
    generatedAt: new Date().toISOString(),
    emailedAt: null,
    ...overrides,
  };
}

describe('renderWeeklyReportPdf', () => {
  it('T3: produces a real, valid PDF — correct magic bytes and a sane nonzero size', async () => {
    const pdf = await renderWeeklyReportPdf(fakeReport(), 'Acme Corp');
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  }, 30_000);
});

describe('renderWeeklyReportEmail', () => {
  it('always includes a required plain-text alternative alongside the HTML', () => {
    const { html, text } = renderWeeklyReportEmail(fakeReport(), 'Acme Corp');
    expect(html).toContain('Acme Corp');
    expect(text).toContain('Acme Corp');
    expect(text).not.toContain('<');
  });

  it('omits the "one thing to improve" box entirely for a genuinely quiet week', () => {
    const quiet = fakeReport({ oneImprovement: null, isQuiet: true });
    const { html, text } = renderWeeklyReportEmail(quiet, 'Acme Corp');
    expect(html).not.toContain('One thing to improve');
    expect(text).not.toContain('One thing to improve');
  });
});
