/**
 * P6-07 T2: "a quiet week produces an honest low-activity report,"
 * and the one-improvement priority logic — pure functions, no
 * database needed (the full generation pipeline is covered by
 * weekly-report.integration.test.ts's own T1).
 */
import { describe, expect, it } from 'vitest';
import { isReadable } from '@sentinel/readability';
import { buildHeadline, pickOneImprovement } from '../weekly-report.js';
import type { CaseListItem } from '@sentinel/db';

function fakeCase(severity: string): CaseListItem {
  return {
    id: 'case-1',
    tenantId: 'tenant-1',
    severity: severity as CaseListItem['severity'],
    title: 'fake case',
    score: null,
    state: 'open',
    entityIds: [],
    signalCount: 1,
    createdAt: new Date().toISOString(),
    windowStart: new Date().toISOString(),
    windowEnd: null,
  };
}

describe('buildHeadline', () => {
  it('T2: a week with zero cases at all is told so plainly, not padded', () => {
    const headline = buildHeadline([], 0);
    expect(headline).toMatch(/no activity/i);
    expect(isReadable(headline)).toBe(true);
  });

  it('T2: a week with only low-priority cases is honestly "nothing serious," not silent about the low-priority ones', () => {
    const headline = buildHeadline([], 3);
    expect(headline).toMatch(/nothing serious/i);
    expect(headline).toMatch(/3/);
    expect(headline).not.toMatch(/urgent|immediately|act now/i);
    expect(isReadable(headline)).toBe(true);
  });

  it('T4: the "nothing serious" headline stays under the readability threshold at any case count, not just small ones', () => {
    for (const n of [1, 2, 5, 10, 42, 100]) {
      expect(isReadable(buildHeadline([], n))).toBe(true);
    }
  });

  it('a week with serious findings says so, without inventing a number it cannot support', () => {
    const headline = buildHeadline([fakeCase('critical'), fakeCase('high')], 5);
    expect(headline).toMatch(/2 things?/i);
    expect(isReadable(headline)).toBe(true);
  });
});

describe('pickOneImprovement', () => {
  it('AC2: names exactly one improvement when actions failed — never a list', () => {
    const improvement = pickOneImprovement({ failed: 2, succeeded: 1 }, []);
    expect(improvement).toMatch(/2 actions/);
    expect(improvement).not.toContain('\n'); // one sentence, not an enumerated list
  });

  it('T4: both the singular and plural failed-action phrasing stay under the readability threshold', () => {
    expect(isReadable(pickOneImprovement({ failed: 1 }, [])!)).toBe(true);
    expect(isReadable(pickOneImprovement({ failed: 7 }, [])!)).toBe(true);
    expect(isReadable(pickOneImprovement({}, ['m365'])!)).toBe(true);
  });

  it('falls back to a degraded connector when nothing failed', () => {
    const improvement = pickOneImprovement({ succeeded: 3 }, ['m365']);
    expect(improvement).toMatch(/Reconnect m365/);
  });

  it('a failed action outranks a degraded connector — one thing, the most actionable one', () => {
    const improvement = pickOneImprovement({ failed: 1 }, ['m365']);
    expect(improvement).toMatch(/1 action/);
    expect(improvement).not.toMatch(/Reconnect/);
  });

  it('T2: genuinely nothing systemic to flag returns null, not a padded suggestion', () => {
    expect(pickOneImprovement({ succeeded: 3 }, [])).toBeNull();
  });
});
