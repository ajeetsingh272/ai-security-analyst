/**
 * The canonical JSON encoding behind the audit log hash chain (P0-06 AC1).
 *
 * `entry_hash = SHA256(prev_hash || canonical_json(row))` is only a chain if
 * the same logical content always produces the same bytes. Plain
 * `JSON.stringify` does not guarantee that — object key order in JavaScript
 * follows insertion order, so `{a:1,b:2}` and `{b:2,a:1}` stringify
 * differently despite being the same data, which would make a writer and a
 * verifier disagree about a hash for no reason connected to tampering at all.
 *
 * This sorts object keys at every level of nesting, recursively, and emits no
 * whitespace. It does not handle every JSON edge case (no BigInt, no
 * special-casing for `undefined` inside arrays) because the audit log's
 * payload is always built by this application, never accepted as opaque
 * external JSON — the input shape is known, and the function can stay small.
 *
 * Shared, not reimplemented, between the writer (packages/db/src/audit/) and
 * the verifier (scripts/verify-audit-chain.mjs via chain-verifier.mjs): two
 * copies of "how to canonicalise" is exactly how a writer and a verifier end
 * up disagreeing about a hash that was never actually tampered with.
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`);
  return `{${parts.join(',')}}`;
}
