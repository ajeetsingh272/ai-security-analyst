/**
 * P6-09 T3: per-key rate limiting for the public API — a fixed window
 * (INCR + EXPIRE on first increment) over Redis, the same mechanism
 * auth/rate-limiter.ts already established for failed sign-ins (see
 * its own doc comment for why fixed-window over sliding-window is the
 * right tradeoff here too). Keyed by the API key's own id, not the
 * tenant or the caller's IP — two keys for the same tenant, or many
 * tenants sharing an egress IP, must not share a budget.
 */
import type { RedisClientType } from 'redis';

/** Documented in docs/architecture/public-api.md — keep both in sync. */
export const API_KEY_RATE_LIMIT = { maxRequests: 60, windowSeconds: 60 };

export interface ApiKeyRateLimitResult {
  limited: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets — also the correct `Retry-After`
   * value when `limited` is true. */
  resetSeconds: number;
}

function keyFor(apiKeyId: string): string {
  return `ratelimit:apikey:${apiKeyId}`;
}

export async function checkApiKeyRateLimit(redis: RedisClientType, apiKeyId: string): Promise<ApiKeyRateLimitResult> {
  const key = keyFor(apiKeyId);
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, API_KEY_RATE_LIMIT.windowSeconds);
  }
  const ttl = await redis.ttl(key);
  const resetSeconds = Math.max(ttl, 0) || API_KEY_RATE_LIMIT.windowSeconds;

  return {
    limited: count > API_KEY_RATE_LIMIT.maxRequests,
    limit: API_KEY_RATE_LIMIT.maxRequests,
    remaining: Math.max(0, API_KEY_RATE_LIMIT.maxRequests - count),
    resetSeconds,
  };
}
