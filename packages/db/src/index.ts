/**
 * @sentinel/db — typed access to the control plane.
 *
 * What this package is: the generated Drizzle schema (src/schema.ts), the column
 * types introspection cannot express (src/types.ts), and a low-level pool
 * factory. That is all.
 *
 * What this package is NOT: the tenant boundary. Nothing exported here sets
 * `app.tenant_id`, and nothing here refuses to run outside a tenant context.
 * That boundary is P0-05 and it belongs in one place, wrapping this one.
 *
 * Reaching for the pool below in application code is therefore a design smell
 * rather than a shortcut, and it is a smell with a visible symptom: row-level
 * security is FORCED on every tenant-scoped table, so a query issued without
 * `app.tenant_id` set does not leak another tenant's rows — it returns none.
 * The failure mode is an empty result, not a breach. That is deliberate, and it
 * is still a bug worth catching at construction time, which is what P0-05 adds.
 */
import { Pool, type PoolConfig } from 'pg';

export * as schema from './schema.js';
export * as relations from './relations.js';
export { bytea, citext } from './types.js';

/** Where the control plane lives, when nothing says otherwise. */
const DEFAULT_URL = 'postgres://sentinel:sentinel@localhost:5434/sentinel';

/**
 * Opens a connection pool to the control plane.
 *
 * Not tenant-scoped — see the note above. Intended to be called once per
 * process, by the tenant-context layer, and not by feature code.
 *
 * The pool is capped low on purpose. Postgres here holds control-plane data
 * only: tenants, cases, actions, audit entries. Per-event volume lives in
 * ClickHouse (ADR-0005), so a process needing a large Postgres pool is usually
 * a process doing something per-event that it should not be doing here.
 */
export function createControlPlanePool(config: PoolConfig = {}): Pool {
  const { connectionString, ...rest } = config;
  return new Pool({
    connectionString:
      connectionString ?? process.env['POSTGRES_URL'] ?? DEFAULT_URL,
    max: 10,
    // Fail fast rather than queue forever. A control-plane query that cannot
    // get a connection in five seconds is already past the point where the
    // request it serves is useful.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...rest,
  });
}
