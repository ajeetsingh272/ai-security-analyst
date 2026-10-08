/**
 * P6-09 AC1: "the OpenAPI specification is generated from code, not
 * hand-maintained." `@fastify/swagger` walks every route's own JSON
 * schema (already load-bearing for Fastify's request/response
 * validation) and assembles a spec from it — the spec IS a reflection
 * of the route definitions, not a separately-authored document that
 * can drift from them. Only the `/v1/*` routes declare a `schema`
 * (see routes/v1/*.ts); every other route in this API is the
 * dashboard's own internal surface, deliberately out of scope for the
 * public spec — `filterToV1` below is what keeps the exported document
 * to just the public surface this ticket is actually about.
 */
import type { FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';

export const OPENAPI_INFO = {
  title: 'Sentinel Public API',
  description: 'See docs/architecture/public-api.md for authentication, scopes, rate limits, and the versioning/deprecation policy.',
  version: '1.0.0',
};

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.0.3',
      info: OPENAPI_INFO,
      // Deliberately '/', not '/v1': @fastify/swagger treats a server
      // `url` as a base path and strips it from every collected route
      // before adding it to the spec — confirmed empirically (every
      // /v1/* route silently vanished from app.swagger()'s own output
      // with `url: '/v1'` set here, since stripping that prefix from
      // e.g. `/v1/cases` would otherwise collide with a bare `/cases`
      // this app's internal routes already register). The version
      // prefix lives in each route's own path instead (routes/v1/*.ts).
      servers: [{ url: '/', description: 'Public API' }],
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        },
      },
      security: [{ apiKey: [] }],
    },
  });
}

/** Every route in this API shares one Fastify instance and therefore
 * one generated spec — `app.swagger()` documents the dashboard's own
 * internal routes too, since they run through the same framework.
 * This keeps the EXPORTED public document to just `/v1/*`, the actual
 * public API surface, rather than leaking internal route shapes that
 * were never meant to be a documented, versioned contract. */
export function filterToV1(fullSpec: Record<string, unknown>): Record<string, unknown> {
  const paths = (fullSpec['paths'] as Record<string, unknown>) ?? {};
  const v1Paths = Object.fromEntries(Object.entries(paths).filter(([path]) => path.startsWith('/v1/')));
  return { ...fullSpec, paths: v1Paths };
}
