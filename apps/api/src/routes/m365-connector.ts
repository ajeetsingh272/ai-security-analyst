/**
 * The M365 admin-consent flow's HTTP surface (P1-02) — connect, callback,
 * revoke. Runs after authPlugin/tenantContextPlugin, same as
 * routes/connectors.ts, so `request.session` is already populated and a
 * request with no session never reaches a handler here at all.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { AuditLogWriter, LocalKMS, TenantCredentialVault } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';
import { OAuthStateStore } from '../connectors/oauth-state-store.js';
import { buildAuthorizeUrl, exchangeCodeForTokens, type M365OAuthConfig } from '../connectors/m365-oauth.js';

export interface M365ConnectorRoutesOptions {
  pool: Pool;
  redis: RedisClientType;
  /** Undefined until a real Entra app registration exists (P1-02 T1's
   * own blocker) — every route below returns 503 rather than crashing
   * when this is unset, so the rest of this service functions normally
   * without it. */
  oauthConfig?: M365OAuthConfig | undefined;
  /** P6-04: where the browser lands after Microsoft redirects back here
   * — the dashboard's own origin, never this API's. Defaults to reading
   * DASHBOARD_BASE_URL from the environment. */
  dashboardBaseUrl?: string;
}

function callbackRedirectUrl(dashboardBaseUrl: string, outcome: 'connected' | 'error', reason?: string): string {
  const url = new URL('/connectors', dashboardBaseUrl);
  url.searchParams.set('m365', outcome);
  if (reason) url.searchParams.set('reason', reason);
  return url.toString();
}

async function m365ConnectorRoutesImpl(fastify: FastifyInstance, options: M365ConnectorRoutesOptions): Promise<void> {
  const { pool, redis, oauthConfig, dashboardBaseUrl = dashboardBaseUrlFromEnv() } = options;
  const stateStore = new OAuthStateStore(redis);

  function requireConfig(reply: { code: (n: number) => { send: (b: unknown) => unknown } }): M365OAuthConfig | undefined {
    if (!oauthConfig) {
      reply.code(503).send({
        error: 'm365_not_configured',
        message:
          'M365_CLIENT_ID/M365_CLIENT_SECRET/M365_REDIRECT_URI are not set — there is no registered Entra app yet. ' +
          'The rest of this flow (state, PKCE, token exchange, encryption, revoke) is fully implemented and tested ' +
          'against a mock token endpoint; only the real Microsoft endpoint has never been exercised.',
      });
      return undefined;
    }
    return oauthConfig;
  }

  // LocalKMS is constructed lazily, per request that actually needs it —
  // not once at plugin-registration time. Found the hard way: constructing
  // it eagerly here made EVERY buildApp() call throw (and every OTHER
  // route's own test suite fail to even boot the app) unless
  // KMS_LOCAL_MASTER_KEY happened to be set in that test's environment,
  // even for a test that has nothing to do with M365 at all. A missing
  // KMS key should degrade only the routes that actually need one, same
  // as a missing oauthConfig does via requireConfig above.
  function requireKms(reply: { code: (n: number) => { send: (b: unknown) => unknown } }): LocalKMS | undefined {
    try {
      return new LocalKMS();
    } catch (err) {
      fastify.log.error({ err }, 'LocalKMS unavailable');
      reply.code(503).send({ error: 'kms_not_configured', message: 'KMS_LOCAL_MASTER_KEY is not set.' });
      return undefined;
    }
  }

  fastify.get('/connectors/m365/connect', { preHandler: requireRole('admin') }, async (request, reply) => {
    const config = requireConfig(reply);
    if (!config) return;

    const session = request.session!; // requireRole already guarantees a session exists
    const { state, codeVerifier } = await stateStore.create({ tenantId: session.tenantId, userId: session.userId });
    const url = buildAuthorizeUrl(config, state, codeVerifier);
    return reply.redirect(url);
  });

  fastify.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/connectors/m365/callback',
    async (request, reply) => {
      const config = requireConfig(reply);
      if (!config) return;

      const { code, state, error, error_description: errorDescription } = request.query;
      if (error) {
        // The admin declined consent, or Microsoft rejected the request —
        // either way this is the ADMIN's outcome to see, not a 500. P6-04:
        // redirected into the wizard, not returned as raw JSON, since a
        // real browser following Microsoft's own redirect here has no way
        // to read a JSON body.
        fastify.log.info({ error, errorDescription }, 'm365 consent declined or rejected');
        return reply.redirect(callbackRedirectUrl(dashboardBaseUrl, 'error', 'consent_declined'));
      }
      if (!code || !state) {
        return reply.redirect(callbackRedirectUrl(dashboardBaseUrl, 'error', 'invalid_callback'));
      }

      const oauthState = await stateStore.consume(state);
      if (!oauthState) {
        // Expired (AC3's 10-minute TTL), already used, or forged — in
        // every case the right answer is "start the consent flow again,"
        // never "trust this anyway."
        return reply.redirect(callbackRedirectUrl(dashboardBaseUrl, 'error', 'invalid_or_expired_state'));
      }

      let tokens;
      try {
        tokens = await exchangeCodeForTokens(config, code, oauthState.codeVerifier);
      } catch (err) {
        fastify.log.error({ err }, 'm365 token exchange failed');
        return reply.redirect(callbackRedirectUrl(dashboardBaseUrl, 'error', 'token_exchange_failed'));
      }

      const kms = requireKms(reply);
      if (!kms) return;

      const vault = new TenantCredentialVault(pool, kms);
      const { encrypted, dekId } = await vault.encryptCredentials({
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
      });

      await pool.query(
        `INSERT INTO connectors (tenant_id, kind, status, credentials, dek_id, last_sync_at)
         VALUES ($1, 'm365', 'healthy', $2, $3, now())
         ON CONFLICT (tenant_id, kind)
         DO UPDATE SET status = 'healthy', credentials = EXCLUDED.credentials, dek_id = EXCLUDED.dek_id,
                       last_error = NULL, last_sync_at = now()`,
        [oauthState.tenantId, encrypted, dekId],
      );

      await new AuditLogWriter(pool).insert({
        actorType: 'human',
        actorId: oauthState.userId,
        action: 'connector.consent_granted',
        subjectType: 'connector',
        subjectId: 'm365',
        payload: { scope: tokens.scope },
      });

      return reply.redirect(callbackRedirectUrl(dashboardBaseUrl, 'connected'));
    },
  );

  fastify.post('/connectors/m365/revoke', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;

    // AC5: "Revoking the connector deletes stored credentials and stops
    // collection within one scheduling interval." The DELETE-the-secret
    // half is unconditional and immediate; "stops collection" is P1-03's
    // own connector noticing (on its next Fetch/HealthCheck) that there
    // is nothing left to authenticate with, once it exists.
    const result = await pool.query(
      `UPDATE connectors SET status = 'revoked', credentials = NULL, dek_id = NULL
       WHERE tenant_id = $1 AND kind = 'm365'`,
      [session.tenantId],
    );
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: 'not_connected' });
    }

    await new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: session.userId,
      action: 'connector.consent_revoked',
      subjectType: 'connector',
      subjectId: 'm365',
    });

    return reply.code(200).send({ ok: true });
  });
}

export const m365ConnectorRoutes = fp(m365ConnectorRoutesImpl, { name: 'sentinel-m365-connector-routes' });

/** Reads M365_CLIENT_ID/M365_CLIENT_SECRET/M365_REDIRECT_URI from the
 * environment — undefined (not a thrown error) if any is missing, which
 * is the expected, normal state until a real Entra app registration
 * exists. `authorityBaseUrl` lets a test point this at a local mock
 * instead of the real Microsoft endpoint. */
export function m365OAuthConfigFromEnv(authorityBaseUrl?: string): M365OAuthConfig | undefined {
  const clientId = process.env['M365_CLIENT_ID'];
  const clientSecret = process.env['M365_CLIENT_SECRET'];
  const redirectUri = process.env['M365_REDIRECT_URI'];
  if (!clientId || !clientSecret || !redirectUri) return undefined;
  return { clientId, clientSecret, redirectUri, authorityBaseUrl };
}

/** P6-04: where the OAuth callback sends the browser once Microsoft
 * redirects back here — always the dashboard app's own origin, never
 * this API's. APP_BASE_URL already exists in .env.example (P0
 * foundation) for exactly this purpose, just unused until now. */
export function dashboardBaseUrlFromEnv(): string {
  return process.env['APP_BASE_URL'] ?? 'http://localhost:3000';
}
