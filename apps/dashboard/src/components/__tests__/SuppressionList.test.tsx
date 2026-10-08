/**
 * P6-11 T1: axe accessibility checks on the suppression list,
 * canManage=true (the richest state — Revoke buttons visible), in
 * both themes.
 */
import { afterEach, describe, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SuppressionList } from '../SuppressionList.client.js';
import { expectNoAxeViolations, forEachTheme } from '../../test-utils/axe.js';
import type { SuppressionListResponse } from '../../lib/suppressions.js';

const SUPPRESSIONS_RESPONSE: SuppressionListResponse = {
  suppressions: [
    {
      id: 'sup-1',
      tenantId: 't1',
      ruleId: 'noisy_login_rule',
      entityId: null,
      reason: 'Known noisy VPN egress IP, tracked in ticket OPS-123',
      createdBy: 'user-1',
      createdByEmail: 'owner@example.invalid',
      createdAt: '2026-03-01T00:00:00.000Z',
      expiresAt: '2026-05-01T00:00:00.000Z',
      revokedAt: null,
      revokedBy: null,
      revokedByEmail: null,
      suppressedCount: 12,
    },
  ],
};

function mockFetch() {
  return vi.fn(async () => new Response(JSON.stringify(SUPPRESSIONS_RESPONSE), { status: 200 })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T1: accessibility (axe-core) on the populated suppression list (admin)', () => {
  it('reports zero violations in both themes', async () => {
    await forEachTheme(async () => {
      vi.stubGlobal('fetch', mockFetch());
      const { container } = render(<SuppressionList canManage />);
      await screen.findByText('noisy_login_rule');

      await expectNoAxeViolations(container);
    });
  });
});
