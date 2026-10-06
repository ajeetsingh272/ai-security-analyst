/**
 * P0-12 T2: the generator produces correct counts from a fixture issue set.
 *
 * Deliberately a tiny, hand-built plan (2 phases, 4 tickets) rather than the
 * real 95-ticket backlog — the point is to know the RIGHT ANSWER by
 * inspection and confirm computeCounts produces exactly that, not to
 * exercise scale.
 */
import { describe, expect, it } from 'vitest';
import { computeCounts, statusOf } from './compute.mjs';

const meta = {
  phases: [
    { key: 'P0', name: 'Foundation', weeks: 3 },
    { key: 'P1', name: 'Ingest', weeks: 4 },
  ],
  trustGuarantees: { TG5: 'Tenants are isolated' },
};

const tickets = [
  { id: 'P0-01', phase: 'P0', points: 3, guarantee: null, tests: [{ id: 'T1', type: 'unit' }] },
  {
    id: 'P0-05',
    phase: 'P0',
    points: 5,
    guarantee: 'TG5',
    tests: [{ id: 'T1', type: 'integration' }, { id: 'T2', type: 'unit' }],
  },
  { id: 'P1-01', phase: 'P1', points: 8, guarantee: null, tests: [{ id: 'T1', type: 'integration' }] },
  { id: 'P1-02', phase: 'P1', points: 2, guarantee: null, tests: [] },
];

describe('statusOf', () => {
  it('a ticket with no issue is Backlog', () => {
    expect(statusOf(null)).toBe('Backlog');
  });
  it('a closed issue is Done, regardless of labels', () => {
    expect(statusOf({ state: 'closed', labels: [], assignee: null })).toBe('Done');
  });
  it('an open issue labeled blocked is Blocked', () => {
    expect(statusOf({ state: 'open', labels: [{ name: 'blocked' }], assignee: null })).toBe('Blocked');
  });
  it('an open, unlabeled, assigned issue is In Progress', () => {
    expect(statusOf({ state: 'open', labels: [], assignee: { login: 'x' } })).toBe('In Progress');
  });
  it('an open, unlabeled, unassigned issue is Ready', () => {
    expect(statusOf({ state: 'open', labels: [], assignee: null })).toBe('Ready');
  });
  it('accepts plain string labels, not just label objects', () => {
    expect(statusOf({ state: 'open', labels: ['in review'], assignee: null })).toBe('In Review');
  });
});

describe('computeCounts', () => {
  it('counts totals correctly against a known fixture', () => {
    const issues = [
      { title: '[P0-01] Monorepo skeleton', state: 'closed', labels: [], assignee: null },
      { title: '[P0-05] Tenant context', state: 'open', labels: [], assignee: null },
      // P1-01 and P1-02 have no matching issue at all — Backlog.
    ];

    const { totals, statusCounts, phases } = computeCounts(tickets, issues, meta);

    expect(totals.tickets).toBe(4);
    expect(totals.done).toBe(1); // only P0-01 closed
    expect(totals.points).toBe(3 + 5 + 8 + 2);
    expect(totals.donePoints).toBe(3); // only P0-01's points
    expect(totals.tests).toBe(1 + 2 + 1 + 0);
    expect(totals.doneTests).toBe(1); // P0-01's one test
    expect(totals.pct).toBe(Math.round((1 / 4) * 100));

    expect(statusCounts).toEqual({
      Backlog: 2, // P1-01, P1-02 — no issue
      Ready: 1, // P0-05 — open, no label, no assignee
      'In Progress': 0,
      'In Review': 0,
      Blocked: 0,
      Done: 1, // P0-01
    });

    const p0 = phases.find((p) => p.key === 'P0');
    expect(p0.total).toBe(2);
    expect(p0.done).toBe(1);
    expect(p0.pct).toBe(50);

    const p1 = phases.find((p) => p.key === 'P1');
    expect(p1.total).toBe(2);
    expect(p1.done).toBe(0);
    expect(p1.pct).toBe(0);
  });

  it('a ticket matched to its issue by exact [ID] prefix, not a substring', () => {
    // [P1-01] must not also match a title containing [P1-010] or similar —
    // the regex anchors on the closing bracket immediately after the id.
    const issues = [{ title: '[P1-01] Something', state: 'closed', labels: [], assignee: null }];
    const { totals } = computeCounts(
      [{ id: 'P1-01', phase: 'P1', points: 1, guarantee: null, tests: [] }],
      issues,
      meta,
    );
    expect(totals.done).toBe(1);
  });

  it('an empty ticket list produces 0%, not NaN', () => {
    const { totals } = computeCounts([], [], meta);
    expect(totals.tickets).toBe(0);
    expect(totals.pct).toBe(0);
  });

  it('guaranteeRows reports only tickets carrying that guarantee key', () => {
    const { guaranteeRows } = computeCounts(tickets, [], meta);
    const tg5 = guaranteeRows.find((r) => r.key === 'TG5');
    expect(tg5.total).toBe(1); // only P0-05
    expect(tg5.tickets.map((t) => t.id)).toEqual(['P0-05']);
  });

  it('testTypeCounts tallies across every ticket, by test type', () => {
    const { testTypeCounts } = computeCounts(tickets, [], meta);
    // unit: P0-01's T1, P0-05's T2 = 2. integration: P0-05's T1, P1-01's T1 = 2.
    expect(testTypeCounts).toEqual({ unit: 2, integration: 2 });
  });
});
