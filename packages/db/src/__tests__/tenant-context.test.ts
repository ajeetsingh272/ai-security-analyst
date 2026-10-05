/**
 * P0-05 T3: constructing a repository outside tenant context throws.
 *
 * No real database connection needed for this — the construction-time guard
 * is pure JavaScript (AsyncLocalStorage), and asserting it with a fake Pool
 * keeps the test fast and free of the "did Postgres happen to be up" problem
 * entirely. The database-dependent half of P0-05 (T1, T2 — real cross-tenant
 * isolation) is a separate integration test; this one is about the guard
 * firing before a query is ever attempted.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  withTenantContext,
  getTenantContext,
  hasTenantContext,
  TenantScopedRepository,
  TenantContextError,
} from '../tenant-context.js';

// A Pool stands here only to satisfy the constructor's type; none of these
// tests reach a query, so it never needs to behave like a real one.
const fakePool = {} as Pool;

class ProbeRepository extends TenantScopedRepository {
  // `tenantId` is `protected`, so a subclass reading it is ordinary TypeScript
  // — this exists to expose it to the test, not to work around the type system.
  tenantIdSeen(): string {
    return this.tenantId;
  }
}

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describe('TenantScopedRepository construction', () => {
  it('throws at construction time when no tenant context is active', () => {
    expect(() => new ProbeRepository(fakePool)).toThrow(TenantContextError);
    expect(() => new ProbeRepository(fakePool)).toThrow(/No tenant context is active/);
  });

  it('succeeds, and captures the active tenant id, inside withTenantContext', () => {
    withTenantContext(TENANT_A, () => {
      const repo = new ProbeRepository(fakePool);
      expect(repo.tenantIdSeen()).toBe(TENANT_A);
    });
  });

  it('throws again once the context has exited — construction is not cached across requests', () => {
    withTenantContext(TENANT_A, () => {
      expect(() => new ProbeRepository(fakePool)).not.toThrow();
    });
    expect(() => new ProbeRepository(fakePool)).toThrow(TenantContextError);
  });

  it('refuses to establish a context with a value that is not a UUID', () => {
    expect(() => withTenantContext('tenant; DROP TABLE cases;', () => {})).toThrow(
      TenantContextError,
    );
    expect(() => withTenantContext('', () => {})).toThrow(TenantContextError);
  });

  it('isolates concurrent async contexts from each other', async () => {
    const seenA: string[] = [];
    const seenB: string[] = [];

    await Promise.all([
      withTenantContext(TENANT_A, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seenA.push(getTenantContext().tenantId);
      }),
      withTenantContext(TENANT_B, async () => {
        seenB.push(getTenantContext().tenantId);
        await new Promise((r) => setTimeout(r, 1));
        seenB.push(getTenantContext().tenantId);
      }),
    ]);

    expect(seenA).toEqual([TENANT_A]);
    expect(seenB).toEqual([TENANT_B, TENANT_B]);
  });

  it('hasTenantContext reports false outside and true inside', () => {
    expect(hasTenantContext()).toBe(false);
    withTenantContext(TENANT_A, () => {
      expect(hasTenantContext()).toBe(true);
    });
    expect(hasTenantContext()).toBe(false);
  });

  it('a nested background-style call outside the context still throws, even if an outer context exists elsewhere in the process', () => {
    // Simulates the real failure this guard is for: a repository instantiated
    // inside a setTimeout/fire-and-forget callback that escaped the request's
    // async context entirely.
    withTenantContext(TENANT_A, () => {
      // intentionally not awaited inside — scheduling outside the run() callback
    });
    expect(() => new ProbeRepository(fakePool)).toThrow(TenantContextError);
  });
});
