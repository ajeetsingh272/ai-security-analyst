/**
 * P5-03/ADR-0007 T6: the real dual-backend NonceStore —
 * @sentinel/approval-tokens only knows the `NonceStore` interface; this
 * is the one place that needs both a Redis client and a Postgres pool,
 * which is why it lives here rather than in that package (same split
 * @sentinel/notifications' dispatcher/@sentinel/db repositories already
 * establish).
 *
 * Redis is the fast path (`SET NX EX`, TTL'd to the token's own
 * remaining lifetime — a burned nonce has no reason to outlive the
 * token it belonged to). Postgres (ApprovalNonceRepository) is always
 * still written to on anything Redis did not ALREADY reject, both
 * because the ADR wants the nonce "persisted" durably and because it is
 * the correctness guarantee when Redis is unavailable, not merely a
 * faster version of the same guarantee.
 */
import type { RedisClientType } from 'redis';
import type { Pool } from 'pg';
import { withTenantContext, ApprovalNonceRepository } from '@sentinel/db';
import type { ApprovalTokenPayload, NonceStore } from '@sentinel/approval-tokens';

const KEY_PREFIX = 'approval-nonce:';

export class RedisPostgresNonceStore implements NonceStore {
  constructor(
    private readonly redis: RedisClientType,
    private readonly pool: Pool,
  ) {}

  async burn(payload: ApprovalTokenPayload): Promise<boolean> {
    const ttlSeconds = Math.max(1, payload.exp - Math.floor(Date.now() / 1000));
    let redisSaysAlreadyUsed = false;
    try {
      const result = await this.redis.set(`${KEY_PREFIX}${payload.nonce}`, '1', { NX: true, EX: ttlSeconds });
      redisSaysAlreadyUsed = result === null;
    } catch {
      // Redis unavailable — fall through to Postgres, which is the
      // correctness backstop, not merely a slower duplicate of this.
    }
    if (redisSaysAlreadyUsed) return false;

    return withTenantContext(payload.tenantId, () => new ApprovalNonceRepository(this.pool).burn(payload.nonce, payload.actionId));
  }
}
