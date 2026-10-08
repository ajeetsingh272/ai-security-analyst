/**
 * The control-plane API's app factory. Nothing in this repo built this
 * before P1-11 — apps/api existed only as a library of auth/tenant-context
 * pieces (P0-09/P0-05) with no Fastify instance assembling them into a
 * running server. P1-11 AC4 ("connector health is visible through the
 * API") is the first requirement that actually needs one to exist, so this
 * is that bootstrap — a factory, not a side-effecting module load, so
 * tests build an isolated instance per run the same way
 * auth.integration.test.ts already did by hand before this existed.
 *
 * Registration order matters and is enforced by the plugins themselves,
 * not just convention here: authPlugin before tenantContextPlugin (see
 * tenant-context.ts's own doc comment for why swapping them makes every
 * request look unauthenticated).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { authPlugin } from './auth/auth-plugin.js';
import { tenantContextPlugin } from './plugins/tenant-context.js';
import { connectorsRoutes } from './routes/connectors.js';
import { m365ConnectorRoutes, m365OAuthConfigFromEnv } from './routes/m365-connector.js';
import { suppressionsRoutes } from './routes/suppressions.js';
import { hotfixRulesRoutes, opsTenantIdFromEnv } from './routes/hotfix-rules.js';
import { dismissalsRoutes } from './routes/dismissals.js';
import { casesRoutes } from './routes/cases.js';
import { caseDetailRoutes } from './routes/case-detail.js';
import { createTenantScopedClickHouseClient } from './clickhouse.js';
import { whatsappWebhookRoutes, whatsappConfigFromEnv, type WhatsAppConfig } from './routes/whatsapp-webhook.js';
import { approvalsRoutes, approvalsConfigFromEnv, acceptedTokenSecrets, type ApprovalsConfig } from './routes/approvals.js';
import { preApprovalsRoutes } from './routes/pre-approvals.js';
import { slackConnectorRoutes, slackOAuthConfigFromEnv } from './routes/slack-connector.js';
import { slackWebhookRoutes, slackWebhookConfigFromEnv, type SlackWebhookConfig } from './routes/slack-webhook.js';
import { resendWebhookRoutes, resendWebhookConfigFromEnv, type ResendWebhookConfig } from './routes/resend-webhook.js';
import { auditExportRoutes } from './routes/audit-export.js';
import { RedisPostgresNonceStore } from './approvals/nonce-store.js';
import type { M365OAuthConfig } from './connectors/m365-oauth.js';
import type { SlackOAuthConfig } from './connectors/slack-oauth.js';

export interface BuildAppOptions {
  pool: Pool;
  redis: RedisClientType;
  /** See AuthPluginOptions' own doc comment — must be true in any real
   * deployment; false only so tests can run over plain HTTP. */
  cookieSecure?: boolean;
  /** Defaults to reading M365_CLIENT_ID/SECRET/REDIRECT_URI from the
   * environment (undefined if unset, which routes/m365-connector.ts
   * handles with a 503, not a crash). Overridable so tests can point it
   * at a local mock token endpoint instead. */
  m365OAuthConfig?: M365OAuthConfig | undefined;
  /** Defaults to reading PLATFORM_OPS_TENANT_ID from the environment
   * (undefined if unset, which routes/hotfix-rules.js handles with a
   * 503, not a crash). Overridable so tests can point it at a fixture
   * tenant instead. */
  opsTenantId?: string | undefined;
  /** Defaults to reading WHATSAPP_VERIFY_TOKEN/WHATSAPP_APP_SECRET from
   * the environment (undefined if unset, which routes/whatsapp-webhook.js
   * handles with a 503, not a crash). Overridable so tests can use a
   * fixed secret instead of real Meta credentials. */
  whatsappConfig?: WhatsAppConfig | undefined;
  /** Defaults to reading APPROVAL_TOKEN_SECRET from the environment
   * (undefined if unset, which routes/approvals.js handles with a 503,
   * not a crash). Overridable so tests can use a fixed secret. */
  approvalsConfig?: ApprovalsConfig | undefined;
  /** Defaults to reading SLACK_CLIENT_ID/SECRET/REDIRECT_URI from the
   * environment (undefined if unset, which routes/slack-connector.js
   * handles with a 503, not a crash). Overridable so tests can point
   * it at a local mock OAuth endpoint instead of real Slack. */
  slackOAuthConfig?: SlackOAuthConfig | undefined;
  /** Defaults to reading SLACK_SIGNING_SECRET from the environment
   * (undefined if unset, which routes/slack-webhook.js handles with a
   * 503, not a crash). Overridable so tests can use a fixed secret. */
  slackWebhookConfig?: SlackWebhookConfig | undefined;
  /** Defaults to reading RESEND_WEBHOOK_SECRET from the environment
   * (undefined if unset, which routes/resend-webhook.js handles with
   * a 503, not a crash). Overridable so tests can use a fixed secret. */
  resendWebhookConfig?: ResendWebhookConfig | undefined;
  /** Defaults to reading CLICKHOUSE_URL from the environment (undefined
   * if unset, which case-detail.js's evidence route handles with a 503,
   * not a crash — same pattern as every other optional integration
   * above). Overridable so tests can point it at a local ClickHouse. */
  clickhouseUrl?: string | undefined;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const {
    pool,
    redis,
    cookieSecure = true,
    m365OAuthConfig = m365OAuthConfigFromEnv(),
    opsTenantId = opsTenantIdFromEnv(),
    whatsappConfig = whatsappConfigFromEnv(),
    approvalsConfig = approvalsConfigFromEnv(),
    slackOAuthConfig = slackOAuthConfigFromEnv(),
    slackWebhookConfig = slackWebhookConfigFromEnv(),
    resendWebhookConfig = resendWebhookConfigFromEnv(),
    clickhouseUrl = process.env.CLICKHOUSE_URL,
  } = options;
  const clickhouse = clickhouseUrl ? createTenantScopedClickHouseClient(clickhouseUrl) : undefined;

  // find-my-way's default maxParamLength (100) is sized for an ordinary
  // id segment, not P5-03's own approval token — a base64url-encoded
  // {caseId, actionId, tenantId, approverId, nonce, exp} payload plus
  // its HMAC signature routinely runs several hundred characters.
  // Without raising this, every request to /approvals/:token 414s
  // before routing even reaches that route's own handler.
  const app = Fastify({ routerOptions: { maxParamLength: 4096 } });

  app.get('/health', async (_request, reply) => reply.code(200).send({ ok: true }));
  app.get('/ready', async (_request, reply) => reply.code(200).send({ ok: true }));

  await app.register(authPlugin, { pool, redis, cookieSecure });
  await app.register(tenantContextPlugin, {
    publicPaths: ['/health', '/ready', '/auth/sign-in', '/auth/sign-out', '/webhooks/whatsapp', '/approvals/:token', '/webhooks/slack/interactions', '/webhooks/resend'],
  });
  await app.register(connectorsRoutes, { pool });
  await app.register(m365ConnectorRoutes, { pool, redis, oauthConfig: m365OAuthConfig });
  await app.register(suppressionsRoutes, { pool });
  await app.register(hotfixRulesRoutes, { pool, opsTenantId });
  await app.register(dismissalsRoutes, { pool });
  await app.register(casesRoutes, { pool });
  await app.register(caseDetailRoutes, { pool, clickhouse });
  await app.register(whatsappWebhookRoutes, { pool, config: whatsappConfig });
  await app.register(approvalsRoutes, { pool, nonceStore: new RedisPostgresNonceStore(redis, pool), config: approvalsConfig });
  await app.register(preApprovalsRoutes, { pool });
  await app.register(slackConnectorRoutes, { pool, redis, oauthConfig: slackOAuthConfig });
  await app.register(slackWebhookRoutes, {
    pool,
    nonceStore: new RedisPostgresNonceStore(redis, pool),
    tokenSecret: approvalsConfig ? acceptedTokenSecrets(approvalsConfig) : undefined,
    config: slackWebhookConfig,
  });
  await app.register(resendWebhookRoutes, { pool, config: resendWebhookConfig });
  await app.register(auditExportRoutes, { pool });

  return app;
}
