/**
 * P5-03/ADR-0007 T6: the Postgres half of single-use token enforcement.
 * `approval_nonces` (P0 foundation, 0001_foundation.sql) has no
 * UPDATE/DELETE grant question to worry about — its PRIMARY KEY on
 * `nonce` is the entire guarantee: `ON CONFLICT DO NOTHING` means a
 * replay inserts zero rows rather than raising an error, the same
 * idiom DegradedQueueRepository.enqueue already uses for its own
 * idempotency guarantee.
 */
import { TenantScopedRepository } from '../tenant-context.js';

export class ApprovalNonceRepository extends TenantScopedRepository {
  /** Returns true the first time this nonce is burned, false if it was
   * already used. */
  async burn(nonce: string, actionId: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const result = await client.query('INSERT INTO approval_nonces (nonce, tenant_id, action_id) VALUES ($1, $2, $3) ON CONFLICT (nonce) DO NOTHING', [
        nonce,
        this.tenantId,
        actionId,
      ]);
      return result.rowCount === 1;
    });
  }
}
