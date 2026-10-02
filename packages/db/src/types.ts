/**
 * Column types drizzle-kit's introspection cannot represent.
 *
 * `drizzle-kit pull` emits `unknown("col")` with a TODO comment for any
 * database type it does not recognise. Left alone that does not compile, and
 * worse, it would compile to the wrong thing if someone "fixed" it by reaching
 * for text. These definitions are the mapping, applied mechanically by
 * scripts/postprocess.mjs after every pull.
 *
 * This file is hand-written and stable. It is the only hand-written part of the
 * schema layer, and it describes types, never tables.
 */
import { customType } from 'drizzle-orm/pg-core';

/**
 * bytea — raw bytes, surfaced as a Node Buffer.
 *
 * Used by audit_log.prev_hash and audit_log.entry_hash, which carry SHA-256
 * digests, and by connectors.credentials, which carries an envelope-encrypted
 * blob. Mapping any of these to a string would invite an encoding to creep in
 * between writing a hash and verifying it, which is precisely the failure the
 * hash chain exists to detect (ADR-0007).
 *
 * node-postgres already decodes bytea to a Buffer. The string branch in
 * fromDriver covers drivers and query paths that hand back the `\x`-prefixed
 * hex form instead, so a digest read through either path compares equal.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer | string }>({
  dataType() {
    return 'bytea';
  },
  fromDriver(value) {
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === 'string') {
      // Postgres renders bytea as a backslash, an "x", then hex digits.
      // 0x5c is that backslash: writing it as a code point keeps this line
      // free of an escape sequence that tooling in the chain can mangle.
      const prefixed = value.charCodeAt(0) === 0x5c && value[1] === 'x';
      const hex = prefixed ? value.slice(2) : value;
      return Buffer.from(hex, 'hex');
    }
    throw new TypeError(
      `bytea: expected Buffer or hex string from driver, got ${typeof value}`,
    );
  },
  toDriver(value) {
    return value;
  },
});

/**
 * citext — case-insensitive text.
 *
 * Used by users.email. The case-insensitivity is a property of the column in
 * Postgres, so it holds for comparisons made in the database whether or not
 * TypeScript knows about it. This type exists so the generated schema compiles
 * and so the column keeps its real database type if it is ever recreated from
 * these definitions; it deliberately does not try to emulate the collation in
 * application code, because a second implementation of "equal" is a bug
 * waiting for the two to disagree.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});
