/**
 * Server-side session storage (P0-09 AC1) — Redis, not a signed/encrypted
 * cookie carrying the session data itself. That choice is what makes
 * "server-side revocation" possible at all: a signed cookie is valid until
 * it expires no matter what the server does, because the server never sees
 * it again after issuing it. A session ID that only unlocks server-held
 * state can be revoked by deleting that state — `revoke()` below — and the
 * cookie that still exists in a browser becomes worthless immediately, not
 * at its stated expiry.
 */
import { randomBytes } from 'node:crypto';
import type { RedisClientType } from 'redis';
import type { Session } from './session.js';

const KEY_PREFIX = 'session:';
const DEFAULT_TTL_SECONDS = 12 * 60 * 60; // 12 hours

function keyFor(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

export class SessionStore {
  constructor(private readonly redis: RedisClientType) {}

  /** 256 bits of randomness, hex-encoded — this IS the credential once
   * issued (whoever holds it can act as this session), so it needs to be
   * unguessable, not merely unique. A UUID (122 bits, and structured) is
   * weaker than it looks for this purpose; a raw random token has no
   * structure for an attacker to reason about at all. */
  async create(session: Session, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<string> {
    const sessionId = randomBytes(32).toString('hex');
    await this.redis.set(keyFor(sessionId), JSON.stringify(session), { EX: ttlSeconds });
    return sessionId;
  }

  /** Merges `patch` into the stored session in place, preserving its
   * remaining TTL (so switching tenant mid-session doesn't quietly extend
   * or shorten how long the user stays signed in). Returns null without
   * writing anything if the session doesn't exist (already expired or
   * revoked) — a tenant switch has nothing to apply to in that case. */
  async update(sessionId: string, patch: Partial<Session>): Promise<Session | null> {
    const current = await this.get(sessionId);
    if (!current) return null;
    const updated: Session = { ...current, ...patch };
    const ttl = await this.redis.ttl(keyFor(sessionId));
    await this.redis.set(keyFor(sessionId), JSON.stringify(updated), {
      EX: ttl > 0 ? ttl : DEFAULT_TTL_SECONDS,
    });
    return updated;
  }

  async get(sessionId: string): Promise<Session | null> {
    const raw = await this.redis.get(keyFor(sessionId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Session;
    } catch {
      // A corrupted value is indistinguishable from "no session" to the
      // caller — surfacing a parse error here would turn a storage problem
      // into every holder of that one bad session ID getting a 500 instead
      // of the clean "please sign in again" a missing session gets.
      return null;
    }
  }

  /** The revocation in "server-side revocation" (AC1). Idempotent — revoking
   * an already-revoked or nonexistent session is not an error. */
  async revoke(sessionId: string): Promise<void> {
    await this.redis.del(keyFor(sessionId));
  }

  /**
   * Revokes every session belonging to a user — "sign out everywhere."
   * Redis has no native "find all keys with this userId" index, and running
   * `KEYS`/`SCAN` over every session on every revoke-all call does not scale
   * past a trivial number of concurrent sessions. A reverse index
   * (`user-sessions:<userId>` → a set of session ids), maintained alongside
   * `create`, is the standard fix — not built here because P0-09's own test
   * list (T3) only requires revoking the ONE session a request is using, and
   * adding an unused, untested index is worse than naming the gap honestly.
   */
  async revokeAllForUser(_userId: string): Promise<never> {
    throw new Error(
      'revokeAllForUser is not implemented. Needs a user -> session ids index ' +
        'that create() does not currently maintain — see this method\'s doc comment.',
    );
  }
}
