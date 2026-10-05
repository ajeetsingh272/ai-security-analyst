/**
 * P0-06 T1, T2, T3, T5 — all pure, no database connection. `verifyChain` and
 * `canonicalJSON` take plain data in and return a verdict; the database-
 * dependent half (T4: UPDATE actually rejected by Postgres grants) is a
 * separate integration test, because mixing "does the algorithm work" with
 * "is Postgres configured correctly" into one test makes a failure's cause
 * ambiguous.
 */
import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  auditEntryContent,
  computeEntryHash,
  verifyChain,
  canonicalJSON,
  type AuditEntryRow,
} from '../index.js';

/** Builds a valid chain of `count` entries for one tenant, using the exact
 * same hashing logic the writer uses — the only way to get a chain that is
 * actually well-formed rather than merely plausible-looking. */
function buildChain(count: number, tenantId = '11111111-1111-4111-8111-111111111111'): AuditEntryRow[] {
  const entries: AuditEntryRow[] = [];
  let prevHash = GENESIS_HASH;

  for (let i = 0; i < count; i++) {
    const content = auditEntryContent({
      tenantId,
      occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      actorType: 'system',
      actorId: 'test-writer',
      action: `action-${i}`,
      subjectType: 'test',
      subjectId: `subject-${i}`,
      payload: { index: i, note: `entry ${i}` },
    });
    const entryHash = computeEntryHash(prevHash, content);
    entries.push({ id: i + 1, prevHash, entryHash, ...content });
    prevHash = entryHash;
  }
  return entries;
}

describe('verifyChain', () => {
  it('T1: accepts a well-formed chain of 1000 entries', () => {
    const chain = buildChain(1000);
    expect(verifyChain(chain)).toEqual({ ok: true });
  });

  it('accepts an empty chain (a tenant with no audit history yet)', () => {
    expect(verifyChain([])).toEqual({ ok: true });
  });

  it('T2: detects a mutated payload and reports the correct entry id', () => {
    const chain = buildChain(50);
    // Mutate entry #30's content WITHOUT recomputing its hash — exactly what
    // an attacker editing a row directly in the database would produce.
    const tampered = chain.map((e, i) =>
      i === 29 ? { ...e, payload: { index: 29, note: 'TAMPERED' } } : e,
    );

    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAtId).toBe(30); // entries are 1-indexed by position
      expect(result.reason).toContain('entry_hash does not match');
    }
  });

  it('T3: detects a deleted middle entry and reports the next surviving entry', () => {
    const chain = buildChain(50);
    // Remove entry #30 entirely, as DELETE would (impossible via grants, but
    // this is what the chain would look like if it somehow happened).
    const withGap = chain.filter((_, i) => i !== 29);

    const result = verifyChain(withGap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Entry #31 is the first row whose prevHash no longer matches the
      // (now-different) preceding hash — you cannot report "id 30 is
      // missing" when id 30 no longer exists to be identified; reporting the
      // first SURVIVING inconsistency is the correct, honest signal.
      expect(result.brokenAtId).toBe(31);
      expect(result.reason).toContain('prev_hash does not match');
    }
  });

  it('detects a chain that does not start from GENESIS_HASH', () => {
    const chain = buildChain(5);
    const wrongStart = chain.map((e, i) => (i === 0 ? { ...e, prevHash: Buffer.alloc(32, 7) } : e));
    const result = verifyChain(wrongStart);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAtId).toBe(1);
  });

  it('detects a swapped entry_hash that is valid-looking but for the wrong row', () => {
    // A subtler tamper than a random mutation: take a hash that IS a correct
    // SHA256 output of SOMETHING, just not of this row — makes sure the check
    // is "does this hash match THIS content", not merely "is this 32 bytes".
    const chain = buildChain(10);
    const swapped = chain.map((e, i) => (i === 4 ? { ...e, entryHash: chain[7]!.entryHash } : e));
    const result = verifyChain(swapped);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAtId).toBe(5);
  });
});

describe('canonicalJSON', () => {
  it('T5: is stable across key insertion order', () => {
    const a = { tenantId: 't1', action: 'login', actorId: 'u1' };
    const b = { actorId: 'u1', tenantId: 't1', action: 'login' };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });

  it('is stable across key order at every level of nesting', () => {
    const a = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const b = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });

  it('distinguishes genuinely different content', () => {
    expect(canonicalJSON({ a: 1 })).not.toBe(canonicalJSON({ a: 2 }));
    expect(canonicalJSON({ a: 1, b: 2 })).not.toBe(canonicalJSON({ a: 1 }));
  });

  it('preserves array order — arrays are not sorted, only object keys are', () => {
    expect(canonicalJSON([1, 2, 3])).not.toBe(canonicalJSON([3, 2, 1]));
  });
});
