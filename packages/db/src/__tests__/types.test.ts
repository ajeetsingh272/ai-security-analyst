/**
 * The bytea mapping is load-bearing for the audit chain.
 *
 * audit_log.prev_hash and audit_log.entry_hash hold raw SHA-256 digests, and the
 * chain verifies by comparing a digest read back from the database against one
 * recomputed in application code (ADR-0007). If the two sides disagree about
 * encoding — hex versus raw bytes, with or without the `\x` prefix Postgres uses
 * in its text output — then every comparison fails, the verifier reports the
 * chain broken, and the bug looks exactly like tamper evidence. A test that
 * distinguishes "the data changed" from "we decoded it differently" is worth
 * more than its size.
 */
import { describe, expect, it } from 'vitest';
import { bytea, citext } from '../types.js';

/**
 * Reaches the driver conversions on the built column.
 *
 * drizzle exposes these through the column instance rather than the type
 * factory, so the test goes through the same construction path the schema does
 * instead of testing a function the real code never calls.
 */
interface BuiltColumn {
  getSQLType(): string;
  mapFromDriverValue(value: unknown): Buffer;
  mapToDriverValue(value: Buffer): unknown;
}

/**
 * `bytea('col')` returns a builder, and the driver conversions plus the declared
 * SQL type live on the column the builder produces. Building it here is the same
 * step pgTable performs, so the test exercises the real construction path rather
 * than a function the schema never calls.
 */
function build(builder: unknown): BuiltColumn {
  // drizzle does not export its builder interface, so reaching the built column
  // means going through `any`. This is the same call pgTable makes internally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (builder as any).build({ name: 'probe' }) as BuiltColumn;
}

function byteaColumn(): BuiltColumn {
  return build(bytea('probe'));
}

describe('bytea', () => {
  const digest = Buffer.from(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'hex',
  );

  it('declares the postgres type as bytea', () => {
    // A column that reported `text` would be accepted by Postgres for writes and
    // would silently corrupt a digest on read.
    expect(byteaColumn().getSQLType()).toBe('bytea');
  });

  it('passes a Buffer through unchanged', () => {
    const col = byteaColumn();
    expect(col.mapFromDriverValue(digest).equals(digest)).toBe(true);
  });

  it('decodes the hex form Postgres emits as text', () => {
    const col = byteaColumn();
    const asText = `\\x${digest.toString('hex')}`;
    expect(col.mapFromDriverValue(asText).equals(digest)).toBe(true);
  });

  it('decodes bare hex without the prefix', () => {
    const col = byteaColumn();
    expect(col.mapFromDriverValue(digest.toString('hex')).equals(digest)).toBe(true);
  });

  it('round-trips a digest through both directions', () => {
    const col = byteaColumn();
    const out = col.mapToDriverValue(digest);
    expect(col.mapFromDriverValue(out).equals(digest)).toBe(true);
  });

  it('treats the prefixed and raw forms as the same bytes', () => {
    // This is the actual failure mode: one write path produces one form, one read
    // path the other, and a chain comparison fails on identical data.
    const col = byteaColumn();
    const fromPrefixed = col.mapFromDriverValue(`\\x${digest.toString('hex')}`);
    const fromBuffer = col.mapFromDriverValue(digest);
    expect(fromPrefixed.equals(fromBuffer)).toBe(true);
  });

  it('refuses a value it cannot decode rather than guessing', () => {
    const col = byteaColumn();
    // Returning an empty Buffer here would turn an encoding bug into a silently
    // wrong hash, which the chain would then report as tampering.
    expect(() => col.mapFromDriverValue(42)).toThrow(TypeError);
    expect(() => col.mapFromDriverValue(null)).toThrow(TypeError);
  });
});

describe('citext', () => {
  it('declares the postgres type as citext', () => {
    // Mapping this to text would drop the case-insensitive comparison that makes
    // "Priya@x.com" and "priya@x.com" one identity rather than two accounts.
    expect(build(citext('email')).getSQLType()).toBe('citext');
  });
});
