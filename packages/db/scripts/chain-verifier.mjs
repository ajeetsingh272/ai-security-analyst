/**
 * The audit log chain verifier (P0-06 AC1, AC4). Pure logic — takes an
 * already-fetched array of rows and returns a verdict, with no database
 * connection of its own. That split is what makes T1/T2/T3 fast unit tests:
 * a synthetic chain of any length, or one with a row deliberately mutated or
 * removed, needs no Postgres to exercise this.
 *
 * `scripts/verify-audit-chain.mjs` is the thin, Postgres-aware CLI wrapper
 * that fetches real rows and calls this.
 */
import { createHash } from 'node:crypto';
import { canonicalJSON } from './canonical-json.mjs';

/**
 * The root of every tenant's chain. 32 zero bytes — the first entry's stored
 * prev_hash must equal this exactly, which is itself part of what verifyChain
 * checks: a chain that does not start from GENESIS_HASH is not verified as
 * "fine, just missing its first entries" — it fails, because a missing
 * prefix is indistinguishable from a deleted prefix, and the whole point of
 * the chain is to not take that on faith.
 */
export const GENESIS_HASH = Buffer.alloc(32);

/**
 * The exact fields hashed for one entry, in the exact shape both the writer
 * and the verifier must agree on. Key order does not matter — canonicalJSON
 * sorts it — but the SET of fields does: adding a field here without the
 * writer also including it would make every future entry unverifiable
 * against entries written before the change.
 *
 * @param {{tenantId: string, occurredAt: string, actorType: string, actorId: string, action: string, subjectType: string, subjectId: string, payload: unknown}} entry
 */
export function auditEntryContent(entry) {
  return {
    tenantId: entry.tenantId,
    occurredAt: entry.occurredAt,
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    payload: entry.payload,
  };
}

/** @param {Buffer} prevHash @param {ReturnType<typeof auditEntryContent>} content */
export function computeEntryHash(prevHash, content) {
  return createHash('sha256')
    .update(Buffer.concat([prevHash, Buffer.from(canonicalJSON(content), 'utf8')]))
    .digest();
}

/**
 * Walks one tenant's chain in id order and reports the first break, if any.
 *
 * Two independent checks per entry, because they catch different attacks:
 *
 *   1. This entry's stored `prevHash` must equal the PRECEDING entry's
 *      `entryHash` (or GENESIS_HASH, for the first entry). This is what
 *      catches a deleted or reordered entry (P0-06 T3) — removing a row
 *      leaves the next surviving row's prevHash pointing at a hash that no
 *      longer precedes it in the sequence.
 *
 *   2. Recomputing SHA256(prevHash || canonicalJSON(content)) must equal the
 *      stored `entryHash`. This is what catches a mutated payload (T2) —
 *      changing any hashed field changes the recomputed hash.
 *
 * Checking only one of these would miss attacks the other catches: a
 * mutated row that also has its own entry_hash "fixed" to match would pass
 * check 2 but still break check 1 for the NEXT row in the chain, since that
 * row's prevHash was computed against the ORIGINAL (now-changed) hash.
 *
 * @param {Array<{id: string|number, prevHash: Buffer, entryHash: Buffer} & ReturnType<typeof auditEntryContent>>} entries
 *   Must be in ascending id order — the order rows were actually written.
 * @returns {{ok: true} | {ok: false, brokenAtId: string|number, reason: string}}
 */
export function verifyChain(entries) {
  let expectedPrev = GENESIS_HASH;

  for (const entry of entries) {
    if (!entry.prevHash.equals(expectedPrev)) {
      return {
        ok: false,
        brokenAtId: entry.id,
        reason:
          'prev_hash does not match the preceding entry in the chain. An entry ' +
          'before this one may have been deleted, altered, or the rows were ' +
          'returned out of order.',
      };
    }

    const recomputed = computeEntryHash(entry.prevHash, auditEntryContent(entry));
    if (!recomputed.equals(entry.entryHash)) {
      return {
        ok: false,
        brokenAtId: entry.id,
        reason:
          'entry_hash does not match its recomputed value. One of this ' +
          'entry\'s own fields was altered after it was written.',
      };
    }

    expectedPrev = entry.entryHash;
  }

  return { ok: true };
}
