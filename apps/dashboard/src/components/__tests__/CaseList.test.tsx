/**
 * P6-11 T1: axe accessibility checks on the case list in its loaded,
 * populated state, in both themes — see CaseDetail.test.tsx's own
 * comment for the established pattern this follows.
 */
import { afterEach, describe, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CaseList } from '../CaseList.client.js';
import { expectNoAxeViolations, forEachTheme } from '../../test-utils/axe.js';
import type { CaseListResponse, CaseFilterOptions } from '../../lib/cases.js';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

const LIST_RESPONSE: CaseListResponse = {
  items: [
    { id: 'case-1', tenantId: 't1', severity: 'critical', title: 'Impossible travel', score: 91, state: 'open', entityIds: ['e1'], signalCount: 3, createdAt: '2026-04-01T00:00:00.000Z', windowStart: '2026-04-01T00:00:00.000Z', windowEnd: null },
    { id: 'case-2', tenantId: 't1', severity: 'low', title: 'Routine password reset', score: 12, state: 'dismissed', entityIds: [], signalCount: 1, createdAt: '2026-04-01T00:00:00.000Z', windowStart: '2026-04-01T00:00:00.000Z', windowEnd: '2026-04-01T01:00:00.000Z' },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};
const FILTER_OPTIONS: CaseFilterOptions = { entities: [], rules: [] };

function mockFetch() {
  return vi.fn(async (url: string) => {
    if (url.includes('/filter-options')) return new Response(JSON.stringify(FILTER_OPTIONS), { status: 200 });
    return new Response(JSON.stringify(LIST_RESPONSE), { status: 200 });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T1: accessibility (axe-core) on the populated case list', () => {
  it('reports zero violations in both themes', async () => {
    await forEachTheme(async () => {
      vi.stubGlobal('fetch', mockFetch());
      const { container } = render(<CaseList />);
      await screen.findByText('Impossible travel');

      await expectNoAxeViolations(container);
    });
  });
});
