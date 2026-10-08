/**
 * P6-11 T1: axe accessibility checks on the weekly report view with a
 * real report AND (canManage=true) the schedule section visible — the
 * richest admin-level state — in both themes.
 */
import { afterEach, describe, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WeeklyReportView } from '../WeeklyReportView.client.js';
import { expectNoAxeViolations, forEachTheme } from '../../test-utils/axe.js';
import type { WeeklyReportListResponse, ReportSchedule } from '../../lib/weekly-report.js';

const LIST_RESPONSE: WeeklyReportListResponse = {
  reports: [
    {
      id: 'report-1',
      tenantId: 't1',
      windowStart: '2026-03-25T00:00:00.000Z',
      windowEnd: '2026-04-01T00:00:00.000Z',
      headline: 'Sentinel caught 1 thing this week that needed attention, and acted on what it could.',
      oneImprovement: "Reconnect m365 — it stopped collecting activity at some point this week.",
      isQuiet: false,
      data: { totalCases: 3, bySeverity: { high: 1, low: 2 }, actionsByStatus: { succeeded: 1 }, entitiesAffected: 2, topCase: { title: 'Impossible travel', severity: 'high' } },
      generatedAt: '2026-04-01T00:05:00.000Z',
      emailedAt: null,
    },
  ],
};
const SCHEDULE_RESPONSE: ReportSchedule = { dayOfWeek: 1, enabled: true };

function mockFetch() {
  return vi.fn(async (url: string) => {
    if (url.includes('/schedule')) return new Response(JSON.stringify(SCHEDULE_RESPONSE), { status: 200 });
    return new Response(JSON.stringify(LIST_RESPONSE), { status: 200 });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T1: accessibility (axe-core) on the weekly report view (admin, with a schedule)', () => {
  it('reports zero violations in both themes', async () => {
    await forEachTheme(async () => {
      vi.stubGlobal('fetch', mockFetch());
      const { container } = render(<WeeklyReportView canManage />);
      await screen.findByText(/Sentinel caught 1 thing/);
      await screen.findByLabelText('Day of week');

      await expectNoAxeViolations(container);
    });
  });
});
