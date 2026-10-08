/**
 * P6-11 T1: axe accessibility checks on the connectors wizard's
 * "connected" state (the richest state — status badge, run-scan and
 * disconnect actions, plus the disconnect confirmation card), in both
 * themes.
 */
import { afterEach, describe, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectorsWizard } from '../ConnectorsWizard.client.js';
import { expectNoAxeViolations, forEachTheme } from '../../test-utils/axe.js';
import type { ConnectorsHealthResponse } from '../../lib/connectors.js';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const CONNECTED_RESPONSE: ConnectorsHealthResponse = {
  connectors: [{ id: 'conn-1', kind: 'm365', status: 'healthy', reason: null, lastError: null, lastSyncAt: '2026-04-01T00:00:00.000Z', lagSeconds: 12 }],
};

function mockFetch() {
  return vi.fn(async () => new Response(JSON.stringify(CONNECTED_RESPONSE), { status: 200 })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T1: accessibility (axe-core) on the connected wizard state', () => {
  it('reports zero violations in both themes', async () => {
    await forEachTheme(async () => {
      vi.stubGlobal('fetch', mockFetch());
      const { container } = render(<ConnectorsWizard />);
      await screen.findByText('Microsoft 365');

      await expectNoAxeViolations(container);
    });
  });
});
