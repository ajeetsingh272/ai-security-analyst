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
import type { M365OAuthConfig } from './connectors/m365-oauth.js';

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
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const {
    pool,
    redis,
    cookieSecure = true,
    m365OAuthConfig = m365OAuthConfigFromEnv(),
    opsTenantId = opsTenantIdFromEnv(),
  } = options;

  const app = Fastify();

  app.get('/health', async (_request, reply) => reply.code(200).send({ ok: true }));
  app.get('/ready', async (_request, reply) => reply.code(200).send({ ok: true }));

  await app.register(authPlugin, { pool, redis, cookieSecure });
  await app.register(tenantContextPlugin, { publicPaths: ['/health', '/ready', '/auth/sign-in', '/auth/sign-out'] });
  await app.register(connectorsRoutes, { pool });
  await app.register(m365ConnectorRoutes, { pool, redis, oauthConfig: m365OAuthConfig });
  await app.register(suppressionsRoutes, { pool });
  await app.register(hotfixRulesRoutes, { pool, opsTenantId });

  return app;
}
