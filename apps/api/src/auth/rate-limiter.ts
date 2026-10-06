/**
 * Failed sign-in rate limiting (P0-09 AC4) — per account AND per IP,
 * independently. Both axes matter for different attacks: limiting only by
 * account lets an attacker spray one password across many accounts from one
 * IP without ever tripping a per-account limit; limiting only by IP lets a
 * botnet with many IPs grind one account's password without tripping a
 * per-IP limit. Either limit being hit blocks the attempt.
 *
 * A fixed window (INCR + EXPIRE on first increment), not a sliding one — a
 * sliding window is more precise at the boundary but needs a sorted set and
 * a cleanup pass; for "block after N failures in a few minutes" the fixed
 * window's one weakness (a burst split across a window boundary could allow
 * up to 2x the nominal limit) is not worth the extra complexity.
 */
import type { RedisClientType } from 'redis';

export interface RateLimitConfig {
  /** Failed attempts allowed before blocking. */
  maxAttempts: number;
  /** Window length, and how long a block lasts once tripped. */
  windowSeconds: number;
}

export const ACCOUNT_LIMIT: RateLimitConfig = { maxAttempts: 5, windowSeconds: 15 * 60 };
export const IP_LIMIT: RateLimitConfig = { maxAttempts: 20, windowSeconds: 15 * 60 };

export interface RateLimitResult {
  blocked: boolean;
  /** Which axis tripped, when blocked — for logging/audit, not for the
   * client response, which should not reveal whether it was the account or
   * IP limit (that distinction is useful account-enumeration information). */
  reason?: 'account' | 'ip';
  retryAfterSeconds?: number;
}

function keyFor(axis: 'account' | 'ip', identifier: string): string {
  // Lower-cased for account (email) so "User@x.com" and "user@x.com" share a
  // counter — matches the citext column's own case-insensitivity, and
  // without this an attacker could evade the limit by varying case per
  // attempt while still reaching the same account.
  const normalised = axis === 'account' ? identifier.toLowerCase() : identifier;
  return `ratelimit:signin:${axis}:${normalised}`;
}

async function checkAndIncrement(
  redis: RedisClientType,
  axis: 'account' | 'ip',
  identifier: string,
  config: RateLimitConfig,
): Promise<{ overLimit: boolean; retryAfterSeconds: number }> {
  const key = keyFor(axis, identifier);
  const count = await redis.incr(key);
  if (count === 1) {
    // First failure in a fresh window — start the clock. A race between this
    // and the INCR above (two requests both getting count===1) would at
    // worst call EXPIRE twice with the same value, which is harmless.
    await redis.expire(key, config.windowSeconds);
  }
  const ttl = await redis.ttl(key);
  return { overLimit: count > config.maxAttempts, retryAfterSeconds: Math.max(ttl, 0) };
}

/** Call once per failed sign-in attempt, after the password check fails —
 * never on a successful one, and never BEFORE checking the password (an
 * attacker should not be able to learn anything from timing whether the
 * limiter ran before or after the password comparison). */
export async function recordFailedSignIn(
  redis: RedisClientType,
  accountIdentifier: string,
  ip: string,
): Promise<RateLimitResult> {
  const [account, ipResult] = await Promise.all([
    checkAndIncrement(redis, 'account', accountIdentifier, ACCOUNT_LIMIT),
    checkAndIncrement(redis, 'ip', ip, IP_LIMIT),
  ]);

  if (account.overLimit) {
    return { blocked: true, reason: 'account', retryAfterSeconds: account.retryAfterSeconds };
  }
  if (ipResult.overLimit) {
    return { blocked: true, reason: 'ip', retryAfterSeconds: ipResult.retryAfterSeconds };
  }
  return { blocked: false };
}

/** Checked BEFORE attempting the password comparison, so an already-blocked
 * account/IP never even reaches `verifyPassword` — scrypt is deliberately
 * slow, and spending that cost on a request that is going to be rejected
 * regardless is a free amplification an attacker gets for nothing. */
export async function isRateLimited(
  redis: RedisClientType,
  accountIdentifier: string,
  ip: string,
): Promise<RateLimitResult> {
  const [accountCount, ipCount] = await Promise.all([
    redis.get(keyFor('account', accountIdentifier)),
    redis.get(keyFor('ip', ip)),
  ]);

  if (accountCount && Number(accountCount) > ACCOUNT_LIMIT.maxAttempts) {
    const ttl = await redis.ttl(keyFor('account', accountIdentifier));
    return { blocked: true, reason: 'account', retryAfterSeconds: Math.max(ttl, 0) };
  }
  if (ipCount && Number(ipCount) > IP_LIMIT.maxAttempts) {
    const ttl = await redis.ttl(keyFor('ip', ip));
    return { blocked: true, reason: 'ip', retryAfterSeconds: Math.max(ttl, 0) };
  }
  return { blocked: false };
}

/** Called on a SUCCESSFUL sign-in, to clear the account's own failure count —
 * a legitimate user who mistyped their password a few times should not stay
 * limited for the rest of the window after finally getting it right. The IP
 * counter is deliberately left alone: a shared IP (an office, a VPN exit)
 * having one account succeed says nothing about whether OTHER accounts being
 * tried from that same IP are legitimate. */
export async function clearFailedSignIns(
  redis: RedisClientType,
  accountIdentifier: string,
): Promise<void> {
  await redis.del(keyFor('account', accountIdentifier));
}
