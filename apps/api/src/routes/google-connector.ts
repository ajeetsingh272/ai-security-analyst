/**
 * The Google Workspace admin-consent flow's HTTP surface (P7-01) — connect,
 * callback, revoke. Mirrors routes/m365-connector.ts almost line for line:
 * same session/role contract, same credential-vault/KMS wiring, same
 * dashboard-redirect shape — the second identity-platform connector proving
 * that shape generalises to a different vendor.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { AuditLogWriter, LocalKMS, TenantCredentialVault } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';
import { OAuthStateStore } from '../connectors/oauth-state-store.js';
import { buildAuthorizeUrl, exchangeCodeForTokens, type GoogleOAuthConfig } from '../connectors/google-oauth.js';
import { dashboardBaseUrlFromEnv } from './m365-connector.js';

export interface GoogleConnectorRoutesOptions {
  pool: Pool;
  redis: RedisClientType;
  /** Undefined until a real Google Cloud OAuth client is registered —
   * every route below returns 503 rather than crashing when this is
   * unset, same pattern m365-connector.ts's own requireConfig uses. */
  oauthConfig?: GoogleOAuthConfig | undefined;
  /** Where the browser lands after Google redirects back here — the
   * dashboard's own origin, never this API's. */
  dashboardBaseUrl?: string;
}

function callbackRedirectUrl(dashboardBaseUrl: string, outcome: 'connected' | 'error', reason?: string): string {
  const url = new URL('/connectors', dashboardBaseUrl);
  url.searchParams.set('google', outcome);
  if (reason) url.searchParams.set('reason', reason);
  return url.toString();
}

async function googleConnectorRoutesImpl(fastify: FastifyInstance, options: GoogleConnectorRoutesOptions): Promise<void> {
  const { pool, redis, oauthConfig, dashboardBaseUrl = dashboardBaseUrlFromEnv() } = options;
  const stateStore = new OAuthStateStore(redis);

  function requireConfig(reply: { code: (n: number) => { send: (b: unknown) => unknown } }): GoogleOAuthConfig | undefined {
    if (!oauthConfig) {
      reply.code(503).send({
        error: 'google_not_configured',
        message:
          'GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI are not set — there is no registered Google Cloud ' +
          'OAuth client yet. The rest of this flow (state, PKCE, token exchange, encryption, revoke) is fully ' +
          'implemented and tested against a mock token endpoint; only the real Google endpoint has never been exercised.',
      });
      return undefined;
    }
    return oauthConfig;
  }

  // Lazily constructed per request, same reasoning m365-connector.ts's
  // own requireKms gives — a missing KMS key should degrade only the
  // routes that actually need one.
  function requireKms(reply: { code: (n: number) => { send: (b: unknown) => unknown } }): LocalKMS | undefined {
    try {
      return new LocalKMS();
    } catch (err) {
      fastify.log.error({ err }, 'LocalKMS unavailable');
      reply.code(503).send({ error: 'kms_not_configured', message: 'KMS_LOCAL_MASTER_KEY is not set.' });
      return undefined;
    }
  }

  fastify.get('/connectors/google/connect', { preHandler: requireRole('admin') }, async (request, reply) => {
    const config = requireConfig(reply);
    if (!config) return;

    const session = request.session!; // requireRole already guarantees a session exists
    const { state, codeVerifier } = await stateStore.create({ tenantId: session.tenantId, userId: session.userId });

    await new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: session.userId,
      action: 'onboarding.connector_connect_started',
      subjectType: 'connector',
      subjectId: 'google_workspace',
    });

    const url = buildAuthorizeUrl(config, state, codeVerifier);
    return reply.redirect(url);
  });

  fastify.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/connectors/google/callback',
    async (request, reply) => {
      const config = requireConfig(reply);
      if (!config) return;

      const { code, state, error, error_description: errorDescription } = request.query;
      if (error) {
        fastify.log.info({ error, errorDescription }, 'google consent declined or rejected');
        return reply.redirect(callbackRedirectUrl(dashboardBaseUrl, 'error', 'consent_declined'));
      }
      if (!code || !state) {
        return reply.redirect(callbackRedirectUrl(dashboardBaseUrl, 'error', 'invalid_callback'));
      }

      const oauthState = await stateStore.consume(state);
      if (!oauthState) {
        return reply.redirect(callbackRedirectUrl(dashboardBaseUrl, 'error', 'invalid_or_expired_state'));
      }

      let tokens;
      try {
        tokens = await exchangeCodeForTokens(config, code, oauthState.codeVerifier);
      } catch (err) {
        fastify.log.error({ err }, 'google token exchange failed');
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
         VALUES ($1, 'google_workspace', 'healthy', $2, $3, now())
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
        subjectId: 'google_workspace',
        payload: { scope: tokens.scope },
      });

      return reply.redirect(callbackRedirectUrl(dashboardBaseUrl, 'connected'));
    },
  );

  fastify.post('/connectors/google/revoke', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;

    const result = await pool.query(
      `UPDATE connectors SET status = 'revoked', credentials = NULL, dek_id = NULL
       WHERE tenant_id = $1 AND kind = 'google_workspace'`,
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
      subjectId: 'google_workspace',
    });

    return reply.code(200).send({ ok: true });
  });
}

export const googleConnectorRoutes = fp(googleConnectorRoutesImpl, { name: 'sentinel-google-connector-routes' });

/** Reads GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI from
 * the environment — undefined (not a thrown error) if any is missing,
 * the expected, normal state until a real Google Cloud OAuth client
 * exists. */
export function googleOAuthConfigFromEnv(authorizeBaseUrl?: string, tokenEndpointBaseUrl?: string): GoogleOAuthConfig | undefined {
  const clientId = process.env['GOOGLE_CLIENT_ID'];
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET'];
  const redirectUri = process.env['GOOGLE_REDIRECT_URI'];
  if (!clientId || !clientSecret || !redirectUri) return undefined;
  return { clientId, clientSecret, redirectUri, authorizeBaseUrl, tokenEndpointBaseUrl };
}
