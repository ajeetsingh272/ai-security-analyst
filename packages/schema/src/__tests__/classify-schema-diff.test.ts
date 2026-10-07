/**
 * P3-08 T1/T2 — pure, in-process tests for the classification logic
 * check-compatibility.mjs's own CLI wraps (file reads, --check,
 * process.exit). These import classify-schema-diff.mjs directly, which
 * has no side effects of its own, unlike importing check-compatibility.mjs
 * itself would (see that file's own module doc comment).
 */
import { describe, expect, it } from 'vitest';
import { findBreakingChanges, isMajorBump } from '../../scripts/classify-schema-diff.mjs';
import type { SchemaField } from '../../scripts/parse-schema.d.mts';

function schema(unions: Record<string, string[]>, interfaces: Record<string, { fields: SchemaField[] }>) {
  // version is irrelevant to findBreakingChanges itself — it never reads
  // it — but required by SchemaShape's own type.
  return { version: '0.0.0', unions, interfaces };
}

describe('findBreakingChanges', () => {
  // T1: a breaking change without a version bump fails the compatibility
  // check — this test proves the CLASSIFICATION half (that the change IS
  // detected as breaking); isMajorBump below proves the version-gate half,
  // and check-compatibility.mjs's own `breaking.length > 0 && !majorBumped`
  // combines the two into the actual CI failure.
  it('T1: detects a removed field as breaking', () => {
    const before = schema({}, { Case: { fields: [{ name: 'id', optional: false, type: { kind: 'string' } }, { name: 'score', optional: true, type: { kind: 'number' } }] } });
    const after = schema({}, { Case: { fields: [{ name: 'id', optional: false, type: { kind: 'string' } }] } });
    expect(findBreakingChanges(before, after)).toEqual(['"Case.score" was removed']);
  });

  it('detects a changed field type as breaking', () => {
    const before = schema({}, { Case: { fields: [{ name: 'score', optional: false, type: { kind: 'number' } }] } });
    const after = schema({}, { Case: { fields: [{ name: 'score', optional: false, type: { kind: 'string' } }] } });
    expect(findBreakingChanges(before, after)).toHaveLength(1);
  });

  it('detects a field becoming required (optional -> required) as breaking', () => {
    const before = schema({}, { Case: { fields: [{ name: 'title', optional: true, type: { kind: 'string' } }] } });
    const after = schema({}, { Case: { fields: [{ name: 'title', optional: false, type: { kind: 'string' } }] } });
    expect(findBreakingChanges(before, after)).toEqual(['"Case.title" changed from optional to required']);
  });

  it('detects a removed union value as breaking', () => {
    const before = schema({ CaseState: ['open', 'dismissed'] }, {});
    const after = schema({ CaseState: ['open'] }, {});
    expect(findBreakingChanges(before, after)).toEqual(['union "CaseState" lost the value "dismissed"']);
  });

  it('detects a removed interface as breaking', () => {
    const before = schema({}, { Case: { fields: [] } });
    const after = schema({}, {});
    expect(findBreakingChanges(before, after)).toEqual(['interface "Case" was removed']);
  });

  // T2: an additive field change passes.
  it('T2: a new optional field is not breaking', () => {
    const before = schema({}, { Case: { fields: [{ name: 'id', optional: false, type: { kind: 'string' } }] } });
    const after = schema({}, {
      Case: {
        fields: [
          { name: 'id', optional: false, type: { kind: 'string' } },
          { name: 'score', optional: true, type: { kind: 'number' } },
        ],
      },
    });
    expect(findBreakingChanges(before, after)).toEqual([]);
  });

  it('a new interface entirely is not breaking', () => {
    const before = schema({}, {});
    const after = schema({}, { Case: { fields: [] } });
    expect(findBreakingChanges(before, after)).toEqual([]);
  });

  it('a new union value is not breaking', () => {
    const before = schema({ Severity: ['high'] }, {});
    const after = schema({ Severity: ['high', 'critical'] }, {});
    expect(findBreakingChanges(before, after)).toEqual([]);
  });

  it('a field becoming optional (required -> optional) is not breaking', () => {
    const before = schema({}, { Case: { fields: [{ name: 'title', optional: false, type: { kind: 'string' } }] } });
    const after = schema({}, { Case: { fields: [{ name: 'title', optional: true, type: { kind: 'string' } }] } });
    expect(findBreakingChanges(before, after)).toEqual([]);
  });

  it('an identical schema has no breaking changes', () => {
    const s = schema({ Severity: ['high'] }, { Case: { fields: [{ name: 'id', optional: false, type: { kind: 'string' } }] } });
    expect(findBreakingChanges(s, s)).toEqual([]);
  });
});

describe('isMajorBump', () => {
  it('T1 (version half): a same-or-lower major is not a major bump', () => {
    expect(isMajorBump('1.2.3', '1.9.0')).toBe(false);
    expect(isMajorBump('1.2.3', '1.2.3')).toBe(false);
  });

  it('a strictly greater major is a major bump', () => {
    expect(isMajorBump('1.2.3', '2.0.0')).toBe(true);
  });

  it('rejects a non-semver string', () => {
    expect(() => isMajorBump('not-a-version', '1.0.0')).toThrow();
  });
});
