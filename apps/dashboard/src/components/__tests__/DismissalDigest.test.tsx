/**
 * P6-11 T1: axe accessibility checks on the dismissal digest's
 * populated state, in both themes.
 */
import { afterEach, describe, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DismissalDigest } from '../DismissalDigest.client.js';
import { expectNoAxeViolations, forEachTheme } from '../../test-utils/axe.js';
import type { DismissalDigestResponse } from '../../lib/dismissals.js';

const DIGEST_RESPONSE: DismissalDigestResponse = {
  day: '2026-04-01',
  digest: [
    { actorType: 'system', reason: 'below_escalation_threshold', caseCount: 4, signalCount: 9 },
    { actorType: 'ai', reason: 'Benign: known-good admin maintenance window', caseCount: 1, signalCount: 1 },
  ],
};

function mockFetch() {
  return vi.fn(async () => new Response(JSON.stringify(DIGEST_RESPONSE), { status: 200 })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T1: accessibility (axe-core) on the populated dismissal digest', () => {
  it('reports zero violations in both themes', async () => {
    await forEachTheme(async () => {
      vi.stubGlobal('fetch', mockFetch());
      const { container } = render(<DismissalDigest />);
      await screen.findByText('below_escalation_threshold');

      await expectNoAxeViolations(container);
    });
  });
});
