/**
 * P5-07: the Slack app-installation flow (connect -> callback ->
 * revoke) plus AC4's own per-severity channel routing, mirroring
 * m365-connector.ts's own connect/callback/revoke shape closely —
 * same OAuthStateStore, same TenantCredentialVault-encrypted
 * `connectors` row (kind = 'slack' this time), same requireConfig/
 * requireKms degrade-to-503 pattern for "not registered yet" rather
 * than crashing the rest of the app.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { AuditLogWriter, LocalKMS, TenantCredentialVault } from '@sentinel/db';
import { buildSlackChannel } from '@sentinel/notifications';
import { requireRole } from '../auth/rbac.js';
import { OAuthStateStore } from '../connectors/oauth-state-store.js';
import { buildSlackAuthorizeUrl, exchangeSlackCode, type SlackOAuthConfig } from '../connectors/slack-oauth.js';

export interface SlackConnectorRoutesOptions {
  pool: Pool;
  redis: RedisClientType;
  oauthConfig?: SlackOAuthConfig | undefined;
}

interface StoredSlackCredentials {
  [key: string]: unknown;
  botAccessToken: string;
  botUserId: string;
  teamId: string;
  teamName: string;
  scope: string;
  channelRouting: Record<string, string>;
}

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

async function slackConnectorRoutesImpl(fastify: FastifyInstance, options: SlackConnectorRoutesOptions): Promise<void> {
  const { pool, redis, oauthConfig } = options;
  const stateStore = new OAuthStateStore(redis);

  function requireConfig(reply: { code: (n: number) => { send: (b: unknown) => unknown } }): SlackOAuthConfig | undefined {
    if (!oauthConfig) {
      reply.code(503).send({
        error: 'slack_not_configured',
        message: 'SLACK_CLIENT_ID/SLACK_CLIENT_SECRET/SLACK_REDIRECT_URI are not set — there is no registered Slack app yet.',
      });
      return undefined;
    }
    return oauthConfig;
  }

  function requireKms(reply: { code: (n: number) => { send: (b: unknown) => unknown } }): LocalKMS | undefined {
    try {
      return new LocalKMS();
    } catch (err) {
      fastify.log.error({ err }, 'LocalKMS unavailable');
      reply.code(503).send({ error: 'kms_not_configured', message: 'KMS_LOCAL_MASTER_KEY is not set.' });
      return undefined;
    }
  }

  async function readCredentials(kms: LocalKMS, tenantId: string): Promise<StoredSlackCredentials | null> {
    const { rows } = await pool.query<{ credentials: Buffer | null }>(`SELECT credentials FROM connectors WHERE tenant_id = $1 AND kind = 'slack' AND status = 'healthy'`, [tenantId]);
    const encrypted = rows[0]?.credentials;
    if (!encrypted) return null;
    const decrypted = await new TenantCredentialVault(pool, kms).decryptCredentials(encrypted);
    return decrypted as unknown as StoredSlackCredentials;
  }

  fastify.get<{ Querystring: { testChannelId?: string } }>('/connectors/slack/connect', { preHandler: requireRole('admin') }, async (request, reply) => {
    const config = requireConfig(reply);
    if (!config) return;

    const session = request.session!;
    const { state } = await stateStore.create({
      tenantId: session.tenantId,
      userId: session.userId,
      ...(request.query.testChannelId !== undefined ? { testChannelId: request.query.testChannelId } : {}),
    });
    return reply.redirect(buildSlackAuthorizeUrl(config, state));
  });

  fastify.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/connectors/slack/callback', async (request, reply) => {
    const config = requireConfig(reply);
    if (!config) return;

    const { code, state, error } = request.query;
    if (error) return reply.code(400).send({ error: 'install_declined', message: error });
    if (!code || !state) return reply.code(400).send({ error: 'invalid_callback', message: 'Missing code or state.' });

    const oauthState = await stateStore.consume(state);
    if (!oauthState) return reply.code(400).send({ error: 'invalid_or_expired_state' });

    let install;
    try {
      install = await exchangeSlackCode(config, code);
    } catch (err) {
      fastify.log.error({ err }, 'slack oauth exchange failed');
      return reply.code(502).send({ error: 'token_exchange_failed' });
    }

    const kms = requireKms(reply);
    if (!kms) return;

    const vault = new TenantCredentialVault(pool, kms);
    const credentials: StoredSlackCredentials = {
      botAccessToken: install.botAccessToken,
      botUserId: install.botUserId,
      teamId: install.teamId,
      teamName: install.teamName,
      scope: install.scope,
      // AC4: seeded with every severity routed to the test channel, if
      // one was given — a real starting point, not an empty map a
      // tenant must fully configure before anything can be delivered.
      channelRouting: oauthState.testChannelId ? Object.fromEntries([...VALID_SEVERITIES].map((s) => [s, oauthState.testChannelId!])) : {},
    };
    const { encrypted, dekId } = await vault.encryptCredentials(credentials);

    await pool.query(
      `INSERT INTO connectors (tenant_id, kind, status, credentials, dek_id, last_sync_at)
       VALUES ($1, 'slack', 'healthy', $2, $3, now())
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
      subjectId: 'slack',
      payload: { team_id: install.teamId, scope: install.scope },
    });

    // T1: "posts a test alert" — real, not simulated, whenever the
    // admin gave a channel to install into; otherwise there is
    // genuinely nowhere to post one yet (no channel has been chosen),
    // which is not a failure of this flow.
    let testAlertPosted = false;
    if (oauthState.testChannelId) {
      try {
        await buildSlackChannel({ botAccessToken: install.botAccessToken, ...(config.baseUrl ? { apiBaseUrl: `${config.baseUrl}/api` } : {}) }).send(oauthState.tenantId, {
          channelId: oauthState.testChannelId,
          title: 'Sentinel is connected',
          bodyMarkdown: "This is a test alert confirming Sentinel can post to this channel. You're all set.",
        });
        testAlertPosted = true;
      } catch (err) {
        fastify.log.warn({ err }, 'slack install succeeded but the test alert failed to post');
      }
    }

    return reply.code(200).send({ ok: true, connector: 'slack', status: 'healthy', teamName: install.teamName, testAlertPosted });
  });

  fastify.post('/connectors/slack/revoke', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;
    // T4: "uninstalling the app cleanly disables the channel and
    // triggers failover" — the disable half is unconditional and
    // immediate here; the failover half is @sentinel/notifications'
    // own dispatcher ALREADY falling through to the next configured
    // channel the moment SlackChannel.send() has nothing to send
    // with (P5-01) — no separate failover code needed or added here.
    const result = await pool.query(`UPDATE connectors SET status = 'revoked', credentials = NULL, dek_id = NULL WHERE tenant_id = $1 AND kind = 'slack'`, [session.tenantId]);
    if (result.rowCount === 0) return reply.code(404).send({ error: 'not_connected' });

    await new AuditLogWriter(pool).insert({ actorType: 'human', actorId: session.userId, action: 'connector.consent_revoked', subjectType: 'connector', subjectId: 'slack' });
    return reply.code(200).send({ ok: true });
  });

  fastify.get('/connectors/slack/channel-routing', { preHandler: requireRole('read_only') }, async (request, reply) => {
    const kms = requireKms(reply);
    if (!kms) return;
    const credentials = await readCredentials(kms, request.session!.tenantId);
    if (!credentials) return reply.code(404).send({ error: 'not_connected' });
    return reply.code(200).send({ channelRouting: credentials.channelRouting });
  });

  fastify.put<{ Body: { severity?: string; channelId?: string } }>('/connectors/slack/channel-routing', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { severity, channelId } = request.body ?? {};
    if (typeof severity !== 'string' || !VALID_SEVERITIES.has(severity) || typeof channelId !== 'string' || channelId.length === 0) {
      return reply.code(400).send({ error: 'invalid_request', message: 'severity must be one of critical/high/medium/low/info, and channelId must be a non-empty string.' });
    }

    const kms = requireKms(reply);
    if (!kms) return;
    const session = request.session!;
    const credentials = await readCredentials(kms, session.tenantId);
    if (!credentials) return reply.code(404).send({ error: 'not_connected' });

    credentials.channelRouting[severity] = channelId;
    const vault = new TenantCredentialVault(pool, kms);
    const { encrypted, dekId } = await vault.encryptCredentials(credentials);
    await pool.query(`UPDATE connectors SET credentials = $2, dek_id = $3 WHERE tenant_id = $1 AND kind = 'slack'`, [session.tenantId, encrypted, dekId]);

    await new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: session.userId,
      action: 'slack_channel_routing_updated',
      subjectType: 'connector',
      subjectId: 'slack',
      payload: { severity, channel_id: channelId },
    });

    return reply.code(200).send({ ok: true, channelRouting: credentials.channelRouting });
  });
}

export const slackConnectorRoutes = fp(slackConnectorRoutesImpl, { name: 'sentinel-slack-connector-routes' });

export function slackOAuthConfigFromEnv(): SlackOAuthConfig | undefined {
  const clientId = process.env['SLACK_CLIENT_ID'];
  const clientSecret = process.env['SLACK_CLIENT_SECRET'];
  const redirectUri = process.env['SLACK_REDIRECT_URI'];
  if (!clientId || !clientSecret || !redirectUri) return undefined;
  return { clientId, clientSecret, redirectUri };
}
