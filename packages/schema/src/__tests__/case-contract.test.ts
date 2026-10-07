/**
 * P3-08 T3 (TypeScript half): a real TypeScript consumer compiles
 * against the frozen Case contract. This file importing `Case` and
 * `CaseState` and building a value that satisfies the full interface IS
 * the proof — if a field's type here disagreed with src/index.ts's own
 * declaration, `tsc`/vitest's own type-checking would fail to compile
 * this file at all, not merely fail an assertion at runtime.
 *
 * The Go half of T3 is go/sentinelschema/cmd/roundtrip (-type=case),
 * exercised by scripts/roundtrip-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import type { Case, CaseState } from '../index.js';

describe('the Case contract', () => {
  it('a value satisfying every field compiles and holds together', () => {
    const state: CaseState = 'investigating';
    const probe: Case = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      severity: 'high',
      title: 'Impossible travel followed by a new inbox rule',
      score: 42.5,
      state,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-01T01:00:00.000Z',
      entityIds: ['user:alice', 'device:laptop-1'],
      signalCount: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    expect(probe.state).toBe('investigating');
    expect(probe.entityIds).toHaveLength(2);
  });

  it('every optional field can be omitted', () => {
    const probe: Case = {
      id: '1',
      tenantId: '2',
      state: 'open',
      windowStart: '2026-01-01T00:00:00.000Z',
      entityIds: [],
      signalCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(probe.severity).toBeUndefined();
  });
});
