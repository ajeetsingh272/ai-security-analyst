/**
 * P6-11 T1: axe accessibility checks on the free-scan report, with a
 * real finding present (the richest state), in both themes.
 */
import { afterEach, describe, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScanReport } from '../ScanReport.client.js';
import { expectNoAxeViolations, forEachTheme } from '../../test-utils/axe.js';
import type { ScanSummary } from '../../lib/scan.js';

const SCAN_RESPONSE: ScanSummary = {
  scanId: 'scan-1',
  windowStart: '2026-04-01T00:00:00.000Z',
  windowEnd: '2026-04-01T00:10:00.000Z',
  totalFindings: 1,
  entitiesAffected: 1,
  isClean: false,
  headline: 'Sentinel found 1 thing worth a closer look.',
  topFinding: { title: 'Impossible travel', severity: 'high' },
  findings: [
    { id: 'case-1', tenantId: 't1', severity: 'high', title: 'Impossible travel', score: 70, state: 'open', entityIds: ['e1'], signalCount: 2, createdAt: '2026-04-01T00:00:00.000Z', windowStart: '2026-04-01T00:00:00.000Z', windowEnd: null },
  ],
};

function mockFetch() {
  return vi.fn(async () => new Response(JSON.stringify(SCAN_RESPONSE), { status: 200 })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T1: accessibility (axe-core) on a populated scan report', () => {
  it('reports zero violations in both themes', async () => {
    await forEachTheme(async () => {
      vi.stubGlobal('fetch', mockFetch());
      const { container } = render(<ScanReport scanId="scan-1" />);
      await screen.findByText('Impossible travel');

      await expectNoAxeViolations(container);
    });
  });
});
