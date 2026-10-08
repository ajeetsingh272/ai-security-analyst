/**
 * P6-09: dashboard-facing management of a tenant's own public API
 * keys — creating and revoking a key is an admin action on the
 * existing cookie-authenticated session, same bar as every other
 * tenant-configuration write in this API (suppressions, connectors).
 * The keys THEMSELVES authenticate `/v1/*` (see auth/api-key-plugin.ts)
 * — this file never accepts an `x-api-key` header, only a cookie
 * session, which is what makes "create a key" possible in the first
 * place (a key cannot be used to mint another key).
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { ApiKeysRepository, AuditLogWriter, type ApiKeyScope } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';
import { generateApiKey } from '../auth/api-key-crypto.js';

export interface ApiKeysRoutesOptions {
  pool: Pool;
}

const VALID_SCOPES = new Set<ApiKeyScope>(['read', 'write']);

function parseScopes(value: unknown): ApiKeyScope[] | null {
  if (value === undefined) return ['read'];
  if (!Array.isArray(value) || value.length === 0) return null;
  const scopes = value.filter((v): v is ApiKeyScope => typeof v === 'string' && VALID_SCOPES.has(v as ApiKeyScope));
  return scopes.length === value.length ? scopes : null;
}

async function apiKeysRoutesImpl(fastify: FastifyInstance, options: ApiKeysRoutesOptions): Promise<void> {
  const { pool } = options;

  fastify.post('/api-keys', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;
    const body = request.body as { name?: unknown; scopes?: unknown };

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return reply.code(400).send({ error: 'name_required' });
    }
    const scopes = parseScopes(body.scopes);
    if (!scopes) {
      return reply.code(400).send({ error: 'invalid_scopes', allowed: Array.from(VALID_SCOPES) });
    }

    const generated = generateApiKey();
    const repo = new ApiKeysRepository(pool);
    const key = await repo.create({
      name: body.name,
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      scopes,
      createdBy: session.userId,
    });

    await new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: session.userId,
      action: 'api_key.create',
      subjectType: 'api_key',
      subjectId: key.id,
      payload: { name: key.name, scopes: key.scopes },
    });

    // The ONLY time the raw secret is ever returned — not stored, not
    // retrievable again afterward (0026_api_keys.sql only keeps its hash).
    return reply.code(201).send({ apiKey: key, rawKey: generated.rawKey });
  });

  fastify.get('/api-keys', { preHandler: requireRole('admin') }, async (_request, reply) => {
    const repo = new ApiKeysRepository(pool);
    const apiKeys = await repo.listActive();
    return reply.code(200).send({ apiKeys });
  });

  fastify.post('/api-keys/:id/revoke', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;
    const { id } = request.params as { id: string };

    const repo = new ApiKeysRepository(pool);
    const revoked = await repo.revoke(id, session.userId);
    if (!revoked) {
      return reply.code(404).send({ error: 'not_found' });
    }

    await new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: session.userId,
      action: 'api_key.revoke',
      subjectType: 'api_key',
      subjectId: id,
    });

    return reply.code(200).send({ apiKey: revoked });
  });
}

export const apiKeysRoutes = fp(apiKeysRoutesImpl, { name: 'sentinel-api-keys-routes' });
