/**
 * P6-03 T2/T4: the case detail screen's own evidence states (found/
 * pending/not_found) and accessibility, against a mocked `/api/cases/*`
 * — the real ClickHouse round trip is covered honestly elsewhere (see
 * apps/api/src/__tests__/case-detail.integration.test.ts's own doc
 * comment: this sandbox cannot start a real ClickHouse). What IS real
 * here: the actual CaseDetail component code, rendering the actual
 * three states a real API response can produce.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { CaseDetail } from '../CaseDetail.client.js';
import { expectNoAxeViolations, forEachTheme } from '../../test-utils/axe.js';
import type { CaseDetailResponse, EvidenceResponse } from '../../lib/case-detail.js';

const BASE_DETAIL: CaseDetailResponse = {
  case: {
    id: 'case-1',
    severity: 'critical',
    title: 'Impossible travel for Priya Sharma',
    signalCount: 1,
    createdAt: '2026-04-01T00:00:00.000Z',
    windowStart: '2026-04-01T00:00:00.000Z',
    windowEnd: null,
  },
  signals: [],
  transitions: [{ fromState: null, toState: 'open', actorType: 'system', actorId: 'correlate', reason: 'first signal clustered', occurredAt: '2026-04-01T00:00:00.000Z' }],
  verdict: {
    severity: 'critical',
    title: 'Someone in Russia signed in as Priya within minutes of her own sign-in in Mumbai',
    claims: [{ text: 'Two sign-ins from IPs over 7,000km apart within 12 minutes.', evidenceRef: ['evt-1'] }],
    attackChain: ['Password reused from a prior breach', 'Sign-in from an unfamiliar location'],
    recommendedActions: [{ playbook: 'revoke_sessions', urgency: 'now', blastRadius: 'single_user' }],
  },
  actions: [],
  mitre: [],
};

function mockFetch(evidenceResponse: Omit<EvidenceResponse, 'tookMs'>) {
  return vi.fn(async (url: string) => {
    if (url.includes('/evidence')) {
      return new Response(JSON.stringify({ ...evidenceResponse, tookMs: 4 }), { status: 200 });
    }
    return new Response(JSON.stringify(BASE_DETAIL), { status: 200 });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CaseDetail evidence states', () => {
  it('T1: expanding a claim displays the referenced event once resolved', async () => {
    vi.stubGlobal('fetch', mockFetch({
      results: [{ id: 'evt-1', status: 'found', tier: 'hot', event: { event_id: 'evt-1', time: '2026-04-01T00:05:00.000Z', class_uid: 1, category_uid: 1, activity_id: 1, severity_id: 4, actor_user_uid: null, target_uid: null, src_ip: '203.0.113.9', message: 'Sign-in from an unfamiliar location' } }],
    }));

    render(<CaseDetail caseId="case-1" />);
    await screen.findByText(/Two sign-ins from IPs/);
    fireEvent.click(screen.getByText(/Two sign-ins from IPs/));

    await screen.findByText(/Sign-in from an unfamiliar location/);
    expect(screen.getByText('verified')).toBeVisible();
  });

  it('P7-05 AC4: evidence retrieved from the cold tier is flagged as a slower path', async () => {
    vi.stubGlobal('fetch', mockFetch({
      results: [{ id: 'evt-1', status: 'found', tier: 'cold', event: { event_id: 'evt-1', time: '2025-01-01T00:05:00.000Z', class_uid: 1, category_uid: 1, activity_id: 1, severity_id: 4, actor_user_uid: null, target_uid: null, src_ip: '203.0.113.9', message: 'Sign-in from an unfamiliar location' } }],
    }));

    render(<CaseDetail caseId="case-1" />);
    await screen.findByText(/Two sign-ins from IPs/);
    fireEvent.click(screen.getByText(/Two sign-ins from IPs/));

    await screen.findByText(/retrieved from cold storage/);
  });

  it('T2: a claim whose evidence is still indexing shows a pending state, not an error', async () => {
    vi.stubGlobal('fetch', mockFetch({ results: [{ id: 'evt-1', status: 'pending' }] }));

    render(<CaseDetail caseId="case-1" />);
    await screen.findByText(/Two sign-ins from IPs/);
    fireEvent.click(screen.getByText(/Two sign-ins from IPs/));

    await screen.findByText(/Still indexing/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('an evidence id that genuinely does not exist is shown distinctly from pending', async () => {
    vi.stubGlobal('fetch', mockFetch({ results: [{ id: 'evt-1', status: 'not_found' }] }));

    render(<CaseDetail caseId="case-1" />);
    await screen.findByText(/Two sign-ins from IPs/);
    fireEvent.click(screen.getByText(/Two sign-ins from IPs/));

    await screen.findByText(/could not be found/);
  });
});

describe('T4: accessibility (axe-core) on the expanded evidence view', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`reports zero violations in ${theme} mode`, async () => {
      const root = document.documentElement;
      const previous = root.getAttribute('data-theme');
      if (theme === 'light') root.setAttribute('data-theme', 'light');
      else root.removeAttribute('data-theme');

      vi.stubGlobal('fetch', mockFetch({ results: [{ id: 'evt-1', status: 'found', tier: 'hot', event: { event_id: 'evt-1', time: '2026-04-01T00:05:00.000Z', class_uid: 1, category_uid: 1, activity_id: 1, severity_id: 4, actor_user_uid: null, target_uid: null, src_ip: '203.0.113.9', message: 'Sign-in from an unfamiliar location' } }] }));

      try {
        const { container } = render(<CaseDetail caseId="case-1" />);
        await screen.findByText(/Two sign-ins from IPs/);
        fireEvent.click(screen.getByText(/Two sign-ins from IPs/));
        await waitFor(() => expect(screen.getByText('verified')).toBeVisible());

        const results = await axe.run(container);
        if (results.violations.length > 0) {
          const detail = results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`).join('\n');
          throw new Error(`axe found ${results.violations.length} violation(s) in ${theme} mode:\n${detail}`);
        }
        expect(results.violations).toHaveLength(0);
      } finally {
        if (previous === null) root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', previous);
      }
    });
  }
});

/** P6-11: these two surfaces (a proposed action awaiting approval, and
 * a dismissed case's challenge control) were added after this file's
 * own original axe suite above and were not yet covered by it. */
describe('T1 (P6-11): accessibility (axe-core) on the proposed-action and challenge-dismissal states', () => {
  it('a case with a proposed action (the approval control) reports zero violations in both themes', async () => {
    const detailWithAction: CaseDetailResponse = {
      ...BASE_DETAIL,
      actions: [{ id: 'action-1', caseId: 'case-1', playbook: 'revoke_sessions', target: {}, blastRadius: 'single_user', status: 'proposed', error: null, createdAt: '2026-04-01T00:00:00.000Z', executedAt: null }],
    };
    const actionFetch = vi.fn(async (url: string) => {
      if (url.includes('/evidence')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(JSON.stringify(detailWithAction), { status: 200 });
    }) as unknown as typeof fetch;

    await forEachTheme(async () => {
      vi.stubGlobal('fetch', actionFetch);
      const { container } = render(<CaseDetail caseId="case-1" />);
      await screen.findByRole('button', { name: 'Approve' });
      await expectNoAxeViolations(container);
    });
  });

  it('a dismissed case (the challenge-dismissal control) reports zero violations in both themes', async () => {
    const dismissedDetail: CaseDetailResponse = {
      ...BASE_DETAIL,
      // transitions[0] is the LATEST (TimelineSection reverses the
      // array for chronological display) — the dismissal must be
      // prepended, not appended, for CaseDetail to treat this case as
      // currently dismissed.
      transitions: [
        { fromState: 'open', toState: 'dismissed', actorType: 'system', actorId: 'correlate', reason: 'below_escalation_threshold', occurredAt: '2026-04-02T00:00:00.000Z' },
        ...BASE_DETAIL.transitions,
      ],
    };
    const dismissedFetch = vi.fn(async (url: string) => {
      if (url.includes('/evidence')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(JSON.stringify(dismissedDetail), { status: 200 });
    }) as unknown as typeof fetch;

    await forEachTheme(async () => {
      vi.stubGlobal('fetch', dismissedFetch);
      const { container } = render(<CaseDetail caseId="case-1" />);
      await screen.findByText('Dismissed by a rule');
      await expectNoAxeViolations(container);
    });
  });
});
