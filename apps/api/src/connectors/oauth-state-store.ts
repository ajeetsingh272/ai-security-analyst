/**
 * Server-side OAuth state (CSRF token + PKCE verifier), Redis-backed —
 * same reasoning as SessionStore: the state value in the authorize URL
 * only unlocks server-held state, so a 10-minute TTL (AC3: "the consent
 * flow completes in under 10 minutes for a non-technical admin") is a
 * real, enforced expiry, not just a client-side hint.
 *
 * `consume()`, not `get()` — an OAuth state value must be usable exactly
 * once; reading it without deleting it would let a replayed callback
 * request (an attacker who intercepted the redirect, or a user who
 * double-submits) reuse the same state/verifier pair a second time.
 */
import { randomBytes } from 'node:crypto';
import type { RedisClientType } from 'redis';

const KEY_PREFIX = 'oauth-state:';
const TTL_SECONDS = 10 * 60;

export interface OAuthState {
  tenantId: string;
  userId: string;
  /** PKCE code_verifier — the authorize request sends only its SHA-256
   * challenge; this is what proves the token-exchange request came from
   * the same party that started the flow, not just anyone who observed
   * the authorization code in a redirect (RFC 7636). Unused by Slack's
   * own install flow (slack-connector.ts) — Slack's real OAuth v2
   * contract has no PKCE parameter at all, not an omission here. */
  codeVerifier: string;
  /** P5-07: the channel an admin picked, in the SAME request that
   * started the Slack install flow, to receive the post-install test
   * alert (T1) and become the tenant's initial default severity
   * route. Slack's own callback only ever echoes back `code`/`state`
   * — nothing else we set on the authorize request — so this has to
   * round-trip through the state store, the same reason codeVerifier
   * does for PKCE. */
  testChannelId?: string;
}

function keyFor(state: string): string {
  return `${KEY_PREFIX}${state}`;
}

export class OAuthStateStore {
  constructor(private readonly redis: RedisClientType) {}

  async create(state: Omit<OAuthState, 'codeVerifier'> & { codeVerifier?: string }): Promise<{ state: string; codeVerifier: string }> {
    const stateToken = randomBytes(32).toString('hex');
    const codeVerifier = state.codeVerifier ?? randomBytes(32).toString('base64url');
    const value: OAuthState = { tenantId: state.tenantId, userId: state.userId, codeVerifier, ...(state.testChannelId !== undefined ? { testChannelId: state.testChannelId } : {}) };
    await this.redis.set(keyFor(stateToken), JSON.stringify(value), { EX: TTL_SECONDS });
    return { state: stateToken, codeVerifier };
  }

  /** Reads and deletes in one round trip (Redis GETDEL) — the "exactly
   * once" guarantee above. Returns null for an unknown, expired, or
   * already-consumed state, which the caller should treat as "this
   * consent attempt is no longer valid, start again" rather than a
   * server error. */
  async consume(state: string): Promise<OAuthState | null> {
    const raw = await this.redis.getDel(keyFor(state));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OAuthState;
    } catch {
      return null;
    }
  }
}
