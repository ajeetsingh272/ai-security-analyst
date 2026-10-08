/**
 * P6-09: populates `request.session` from an `x-api-key` header, for
 * the public `/v1/*` API — a sibling to auth-plugin.ts's cookie-based
 * session, not a replacement for it. Reusing the exact same
 * `request.session` contract means `tenantContextPlugin` (tenant
 * scoping + RLS) and every existing `requireRole` check work
 * unmodified for an API-key-authenticated request; there is no
 * parallel authorization system to keep in sync with the cookie path.
 *
 * MUST be registered after `authPlugin` and before `tenantContextPlugin`
 * (same ordering constraint tenant-context.ts documents for authPlugin
 * itself — Fastify runs top-level `onRequest` hooks in registration
 * order, and this hook needs to see whether a cookie session already
 * populated `request.session` before deciding whether to look at the
 * header at all).
 *
 * T4 ("a revoked key is rejected immediately"): this hook does not
 * merely leave `request.session` unset for an invalid/revoked key — it
 * replies 401 directly, rather than deferring to tenantContextPlugin's
 * own generic "no session" 401. An unknown key and a revoked key are
 * rejected with the IDENTICAL response (same status, same body) so a
 * caller cannot use the response to learn whether a guessed key ever
 * existed.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { findApiKeyByHash, touchApiKeyLastUsed, apiKeyScopesToRole } from '@sentinel/db';
import { hashApiKey } from './api-key-crypto.js';
import { checkApiKeyRateLimit } from './api-key-rate-limiter.js';
import './session.js';

export interface ApiKeyPluginOptions {
  pool: Pool;
  redis: RedisClientType;
}

const API_KEY_HEADER = 'x-api-key';

function apiKeyPluginImpl(fastify: FastifyInstance, options: ApiKeyPluginOptions, done: (err?: Error) => void): void {
  const { pool, redis } = options;

  fastify.addHook('onRequest', async (request, reply) => {
    // A cookie session, if present, always wins — an API key header
    // sent alongside an authenticated dashboard session (e.g. a stray
    // header from a shared HTTP client config) should never silently
    // downgrade or override who the request already is.
    if (request.session) return;

    const header = request.headers[API_KEY_HEADER];
    const rawKey = Array.isArray(header) ? header[0] : header;
    if (!rawKey) return; // no key offered — tenantContextPlugin's own 401 applies, same as any other unauthenticated request

    const keyRow = await findApiKeyByHash(pool, hashApiKey(rawKey));
    if (!keyRow) {
      return reply.code(401).send({ error: 'invalid_api_key' });
    }

    const rateLimit = await checkApiKeyRateLimit(redis, keyRow.id);
    reply.header('ratelimit-limit', String(rateLimit.limit));
    reply.header('ratelimit-remaining', String(rateLimit.remaining));
    reply.header('ratelimit-reset', String(rateLimit.resetSeconds));
    if (rateLimit.limited) {
      reply.header('retry-after', String(rateLimit.resetSeconds));
      return reply.code(429).send({ error: 'rate_limited', retryAfterSeconds: rateLimit.resetSeconds });
    }

    // Best-effort bookkeeping — never blocks or fails the request it's
    // attached to (see touchApiKeyLastUsed's own doc comment).
    void touchApiKeyLastUsed(pool, keyRow.id);

    request.session = {
      tenantId: keyRow.tenantId,
      userId: `api-key:${keyRow.id}`,
      role: apiKeyScopesToRole(keyRow.scopes),
    };
  });

  done();
}

export const apiKeyPlugin = fp(apiKeyPluginImpl, { name: 'sentinel-api-key-auth' });
