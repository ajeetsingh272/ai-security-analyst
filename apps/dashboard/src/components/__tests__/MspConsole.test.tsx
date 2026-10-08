/**
 * P6-11 T1: axe accessibility checks on the MSP console's populated
 * client list, in both themes.
 */
import { afterEach, describe, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MspConsole } from '../MspConsole.client.js';
import { expectNoAxeViolations, forEachTheme } from '../../test-utils/axe.js';
import type { MspClientsResponse } from '../../lib/msp.js';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const CLIENTS_RESPONSE: MspClientsResponse = {
  clients: [
    { tenantId: 't1', name: 'Linked client A', openCriticalCount: 2 },
    { tenantId: 't2', name: 'Linked client B', openCriticalCount: 0 },
  ],
};

function mockFetch() {
  return vi.fn(async () => new Response(JSON.stringify(CLIENTS_RESPONSE), { status: 200 })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T1: accessibility (axe-core) on the populated MSP console', () => {
  it('reports zero violations in both themes', async () => {
    await forEachTheme(async () => {
      vi.stubGlobal('fetch', mockFetch());
      const { container } = render(<MspConsole />);
      await screen.findByText('Linked client A');

      await expectNoAxeViolations(container);
    });
  });
});
