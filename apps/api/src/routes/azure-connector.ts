/**
 * The Azure/Entra ID connector's HTTP surface (P7-03) — mirrors
 * aws-connector.ts's own "no OAuth, single authenticated POST" shape
 * for the same reason: there is no third party to redirect a browser
 * to. Even simpler than AWS's own route: Azure's SAS connection string
 * is fully self-contained (no server-generated external id the admin
 * needs to read first), so this is one POST and one revoke, nothing
 * else.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { AuditLogWriter, LocalKMS, TenantCredentialVault } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';

export interface AzureConnectorRoutesOptions {
  pool: Pool;
}

function requireKms(fastify: FastifyInstance, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): LocalKMS | undefined {
  try {
    return new LocalKMS();
  } catch (err) {
    fastify.log.error({ err }, 'LocalKMS unavailable');
    reply.code(503).send({ error: 'kms_not_configured', message: 'KMS_LOCAL_MASTER_KEY is not set.' });
    return undefined;
  }
}

async function azureConnectorRoutesImpl(fastify: FastifyInstance, options: AzureConnectorRoutesOptions): Promise<void> {
  const { pool } = options;

  fastify.post<{ Body: { connectionString?: string; eventHubName?: string; consumerGroup?: string } }>(
    '/connectors/azure/connect',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const { connectionString, eventHubName, consumerGroup } = request.body ?? {};

      // Shape-only validation — same deliberate boundary aws-connector.ts's
      // own connect route draws: whether this connection string's SAS key
      // is actually valid, and whether eventHubName actually exists in
      // the customer's namespace, can only be proven by a real AMQP
      // connection attempt, which go/sentinelconnector/azure already
      // makes for real on its own next scheduled cycle (the same async
      // health-degradation path every connector already has).
      if (!connectionString || !connectionString.startsWith('Endpoint=sb://') || !connectionString.includes('SharedAccessKey=')) {
        return reply.code(400).send({
          error: 'invalid_connection_string',
          message: 'connectionString must be an Event Hub namespace SAS connection string (Endpoint=sb://...;SharedAccessKeyName=...;SharedAccessKey=...).',
        });
      }
      if (!eventHubName) {
        return reply.code(400).send({ error: 'invalid_event_hub_name', message: 'eventHubName is required.' });
      }

      const kms = requireKms(fastify, reply);
      if (!kms) return;

      const session = request.session!;
      const vault = new TenantCredentialVault(pool, kms);
      const { encrypted, dekId } = await vault.encryptCredentials({
        connectionString,
        eventHubName,
        consumerGroup: consumerGroup ?? '',
      });

      await pool.query(
        `INSERT INTO connectors (tenant_id, kind, status, credentials, dek_id)
         VALUES ($1, 'azure', 'healthy', $2, $3)
         ON CONFLICT (tenant_id, kind)
         DO UPDATE SET status = 'healthy', credentials = EXCLUDED.credentials, dek_id = EXCLUDED.dek_id, last_error = NULL`,
        [session.tenantId, encrypted, dekId],
      );

      await new AuditLogWriter(pool).insert({
        actorType: 'human',
        actorId: session.userId,
        action: 'connector.consent_granted',
        subjectType: 'connector',
        subjectId: 'azure',
        payload: { eventHubName },
      });

      return reply.code(200).send({ ok: true });
    },
  );

  fastify.post('/connectors/azure/revoke', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;

    const result = await pool.query(
      `UPDATE connectors SET status = 'revoked', credentials = NULL, dek_id = NULL
       WHERE tenant_id = $1 AND kind = 'azure'`,
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
      subjectId: 'azure',
    });

    return reply.code(200).send({ ok: true });
  });
}

export const azureConnectorRoutes = fp(azureConnectorRoutesImpl, { name: 'sentinel-azure-connector-routes' });
