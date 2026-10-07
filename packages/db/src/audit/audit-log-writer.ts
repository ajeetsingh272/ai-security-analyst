/**
 * Writes hash-chained audit entries (P0-06 AC1, ADR-0007, trust guarantee
 * TG6). The canonical JSON encoding and hash computation live in
 * scripts/chain-verifier.mjs and scripts/canonical-json.mjs — shared with the
 * verifier so there is exactly one implementation of "how a hash is
 * computed," never a writer's version and a verifier's version that could
 * drift apart and make a real tamper report indistinguishable from the two
 * implementations merely disagreeing with each other.
 *
 * A concurrency correctness note that the acceptance tests do not exercise
 * directly but that matters in production: two concurrent writes for the
 * same tenant must not both read the same "last hash" and each compute an
 * entry claiming to follow it — that would fork the chain into two branches
 * sharing a parent, and `verifyChain` has no way to know which branch is
 * real. `insert` prevents this with `pg_advisory_xact_lock`, keyed by the
 * tenant id, held for the transaction's duration — not `SELECT ... FOR
 * UPDATE`, which was tried first and rejected with "permission denied for
 * table audit_log": row-level locking requires the UPDATE privilege in
 * Postgres, and sentinel_app does not have it here. An advisory lock needs
 * no table privilege at all.
 */
import type { PoolClient } from 'pg';
import { TenantScopedRepository } from '../tenant-context.js';
import {
  GENESIS_HASH,
  auditEntryContent,
  computeEntryHash,
  type AuditEntryContentInput,
} from '../../scripts/chain-verifier.mjs';

export type ActorType = 'human' | 'ai' | 'system' | 'connector';

export interface AuditEntryInput {
  actorType: ActorType;
  actorId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  /** Must be JSON-serialisable. Never a secret, a credential, or a raw log
   * payload — that redaction boundary is P0-10's, enforced upstream of this
   * writer, not re-checked here. */
  payload?: unknown;
  /**
   * Overrides the generated timestamp. Exists for tests that need a
   * deterministic `occurredAt`; production call sites should leave this
   * unset and let the writer use the current time.
   */
  occurredAt?: Date;
}

export interface WrittenAuditEntry {
  id: string;
  occurredAt: string;
  entryHash: Buffer;
}

/**
 * Writes one entry against an ALREADY-OPEN client/transaction — the
 * standalone function `insert`/`insertTx` both call, and that a caller
 * owning its own transaction (e.g. CasesRepository.challengeDismissal,
 * P3-07) can also call directly, so its own write and this audit entry
 * commit atomically or not at all. client must already be running as
 * sentinel_app with app.tenant_id set to tenantId (i.e. obtained via
 * TenantScopedRepository's own withTransaction) — this function does not
 * establish tenant context itself, the same contract go/sentinelaudit's
 * WriteTx has for the identical reason.
 */
export async function writeAuditEntryTx(
  client: PoolClient,
  tenantId: string,
  input: AuditEntryInput,
): Promise<WrittenAuditEntry> {
  const occurredAt = (input.occurredAt ?? new Date()).toISOString();

  // pg_advisory_xact_lock, not SELECT ... FOR UPDATE — that was the first
  // version of this method, and it failed with "permission denied for
  // table audit_log" the first time it ran against the real database.
  // FOR UPDATE row-locking requires the UPDATE privilege on the table in
  // Postgres, which sentinel_app does not have on audit_log — the REVOKE
  // that makes TG6 hold is exactly what made that locking idiom
  // unusable here. An advisory lock needs no table privilege at all; it
  // is keyed by an arbitrary integer rather than a row, so
  // `hashtext(tenant_id)` scopes it to this tenant without touching
  // audit_log before the row that matters is actually read. `_xact_`
  // releases automatically at COMMIT or ROLLBACK, same as the `SET
  // LOCAL` calls elsewhere in this file — nothing to release by hand.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tenantId]);

  const prev = await client.query<{ entry_hash: Buffer }>(
    `SELECT entry_hash FROM audit_log
      WHERE tenant_id = current_setting('app.tenant_id')::uuid
      ORDER BY id DESC
      LIMIT 1`,
  );
  const prevHash: Buffer = prev.rows[0]?.entry_hash ?? GENESIS_HASH;

  const content: AuditEntryContentInput = auditEntryContent({
    tenantId,
    occurredAt,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    payload: input.payload ?? {},
  });
  const entryHash = computeEntryHash(prevHash, content);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO audit_log
       (tenant_id, occurred_at, actor_type, actor_id, action, subject_type, subject_id, payload, prev_hash, entry_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      tenantId,
      occurredAt,
      input.actorType,
      input.actorId,
      input.action,
      input.subjectType,
      input.subjectId,
      JSON.stringify(input.payload ?? {}),
      prevHash,
      entryHash,
    ],
  );

  return { id: rows[0]!.id, occurredAt, entryHash };
}

export class AuditLogWriter extends TenantScopedRepository {
  /**
   * Writes one entry and returns its id and hash, in its OWN transaction.
   * A call site that needs the entry to commit atomically with some other
   * write (e.g. a case transition) should use `writeAuditEntryTx` directly
   * with its own already-open client instead.
   */
  async insert(input: AuditEntryInput): Promise<WrittenAuditEntry> {
    return this.withTransaction((client) => writeAuditEntryTx(client, this.tenantId, input));
  }
}
