/**
 * The tenant context boundary (P0-05, ADR-0008, trust guarantee TG5).
 *
 * The threat this defends against is not an attacker at the perimeter. It is
 * a developer writing `repo.findCases()` and forgetting which tenant they are
 * even operating as. Row-level security (0001_foundation.sql) is the database
 * half of that defence: an unfiltered query returns only the caller's own
 * rows, never another tenant's, because Postgres enforces it below the
 * application. This file is the application half — the thing that makes
 * "which tenant" a question answerable exactly once per request, rather than
 * threaded by hand through every function call that might eventually touch
 * the database.
 *
 * Two mechanisms, and they are deliberately independent:
 *
 *   1. AsyncLocalStorage carries the current tenant id through a request's
 *      async call graph without it being an explicit parameter anywhere.
 *   2. `TenantScopedRepository` reads that context AT CONSTRUCTION TIME and
 *      throws immediately if none is active — not at the first query, which
 *      would let a misconstructed repository sit unused for a while before
 *      failing, in whatever code path happens to call it first.
 *
 * Postgres is still the backstop if both of these are somehow bypassed. This
 * is defence in depth, not a replacement for FORCE ROW LEVEL SECURITY.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';

export interface TenantContext {
  readonly tenantId: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * The role every tenant-scoped query actually runs as, regardless of which
 * role the pool authenticated with. A fixed literal controlled entirely by
 * this file, never derived from input — `SET LOCAL ROLE` does not accept a
 * parameterised identifier, so this is interpolated directly, which is only
 * safe because it is a constant.
 */
const APP_ROLE = 'sentinel_app';

/** Minimal UUID shape check — not full RFC 4122 validation, just "this cannot
 * possibly be a UUID" rejected early, before it reaches a SQL parameter. */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/**
 * Runs `fn` with `tenantId` as the active tenant context for everything it
 * calls, synchronously or asynchronously, until it returns or throws.
 *
 * This is the one place a tenant id should be "set" in ordinary application
 * code — anything expressible as "run this one function with a tenant active"
 * should use this, not `enterTenantContext` below. Nothing downstream should
 * accept a tenant id as a parameter when it could instead read
 * `getTenantContext()`, because a parameter can be passed wrong and this
 * cannot be.
 */
export function withTenantContext<T>(tenantId: string, fn: () => T): T {
  assertTenantIdLooksReal(tenantId, 'withTenantContext');
  return storage.run({ tenantId }, fn);
}

function assertTenantIdLooksReal(tenantId: string, caller: string): void {
  if (!UUID_LIKE.test(tenantId)) {
    throw new TenantContextError(
      `${caller}: "${tenantId}" is not a UUID. Refusing to establish a tenant ` +
        'context with a value that cannot be a real tenant id — this is almost ' +
        'always a bug upstream (wrong field read from the session), and ' +
        'proceeding would make that bug someone else\'s zero-rows mystery later.',
    );
  }
}

/**
 * Establishes `tenantId` as the active context for the REST OF THE CURRENT
 * EXECUTION — existing for exactly one reason: integrating with a callback-
 * style middleware hook (Fastify's `onRequest(request, reply, done)`, Express
 * equivalents), where `withTenantContext` does not work.
 *
 * The reason is a genuine AsyncLocalStorage trap, not a style preference.
 * `withTenantContext` wraps a callback in `storage.run()`; that propagates
 * context to anything NEW started while the callback is on the stack. But a
 * framework hook's `done` callback typically RESOLVES A PROMISE THE FRAMEWORK
 * ALREADY CREATED before calling your hook at all — so calling `done()`
 * (even synchronously, even from inside `run()`) does not retroactively make
 * that pre-existing promise's `.then()` continuation — which is what actually
 * drives the next lifecycle phase, including the route handler — inherit
 * `run()`'s context. The continuation inherits whatever context was active
 * when the framework's own `await` expression was first evaluated, which is
 * before your hook ran. `withTenantContext` would appear to work (no error,
 * no warning) while the context silently fails to reach the handler — which
 * is exactly how P0-05's own Fastify plugin tests caught this the first time.
 *
 * `enterWith` sidesteps the problem by mutating the ambient context for the
 * remainder of the CURRENT async execution directly, rather than scoping it
 * to a callback's dynamic extent — so it is available to whatever runs next,
 * regardless of whose promise drives that continuation. There is no matching
 * "exit" call; the context is scoped to this request's AsyncLocalStorage
 * frame already created by Node for the current I/O callback and is released
 * when that frame ends, the same way `run()`'s context is released when its
 * callback returns.
 */
export function enterTenantContext(tenantId: string): void {
  assertTenantIdLooksReal(tenantId, 'enterTenantContext');
  storage.enterWith({ tenantId });
}

/**
 * Reads the active tenant context, throwing if none is active.
 *
 * There is no "try" variant exported. A caller that wants to branch on
 * "is there a tenant context" is almost always a caller that should not be
 * running this code path outside one at all — the one legitimate exception
 * (background jobs that intentionally span tenants, ADR-0007/sentinel_jobs)
 * uses a different role entirely and does not go through this module.
 */
export function getTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new TenantContextError(
      'No tenant context is active. This code is running outside ' +
        'withTenantContext() — either middleware did not run, or this is a ' +
        'background job that should be using the sentinel_jobs role directly ' +
        'rather than going through TenantScopedRepository.',
    );
  }
  return ctx;
}

export function hasTenantContext(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Base class for any repository that reads or writes tenant-scoped tables.
 *
 * The constructor is where the guarantee lives (P0-05 AC4): it calls
 * `getTenantContext()` immediately, so a repository instantiated outside a
 * tenant context throws at `new XRepository()`, not at the first `.find()` —
 * construction-time failure is loud and points at the actual mistake (missing
 * middleware, a background job built wrong); a query-time failure would
 * surface somewhere far from the cause, possibly after other side effects
 * already ran.
 */
export abstract class TenantScopedRepository {
  protected readonly tenantId: string;
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.tenantId = getTenantContext().tenantId;
    this.pool = pool;
  }

  /**
   * Runs `fn` with a client whose transaction has `app.tenant_id` set to the
   * current tenant, via `SET LOCAL`.
   *
   * `SET LOCAL`, not `SET` — this is not a style preference. `SET` is
   * session-scoped, and under any connection pooler (PgBouncer in transaction
   * mode, or even this process's own `pg.Pool` reusing a physical connection
   * across requests) a session-scoped value leaks into the NEXT request that
   * happens to be handed the same connection, which could belong to a
   * different tenant entirely. `SET LOCAL` is scoped to the transaction and
   * is unset automatically on COMMIT or ROLLBACK, so there is no connection
   * state to leak regardless of what the pool does with the connection next.
   */
  protected async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // This line is the whole guarantee. `createControlPlanePool`'s default
      // connection string authenticates as `sentinel`, the cluster's initial
      // superuser (POSTGRES_USER in docker-compose), and superusers bypass
      // row-level security unconditionally — FORCE or not, policy or not.
      // Without switching role here, every query this class ever runs would
      // execute with RLS silently disabled, and nothing about that failure
      // would be visible: no error, no empty result, just every tenant's
      // rows, every time. `SET LOCAL` (not `SET`) means the switch reverts
      // automatically at COMMIT or ROLLBACK, so it can never leak onto a
      // pooled connection's next, unrelated use.
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      // Parameterised, not interpolated: this.tenantId passed through
      // withTenantContext's UUID check, but set_config's second argument is
      // still a value, never string-built into the SQL text.
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', this.tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        // The original error is what the caller needs; a failed rollback on
        // an already-broken connection is not new information worth masking it.
      });
      throw err;
    } finally {
      client.release();
    }
  }
}
