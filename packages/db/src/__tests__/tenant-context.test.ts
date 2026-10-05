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
  enterTenantContext,
  exitTenantContext,
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

describe('enterTenantContext / exitTenantContext', () => {
  it('enterTenantContext establishes a context that persists past the call that made it — unlike withTenantContext, there is no callback scoping it', () => {
    expect(hasTenantContext()).toBe(false);
    enterTenantContext(TENANT_A);
    expect(hasTenantContext()).toBe(true);
    expect(getTenantContext().tenantId).toBe(TENANT_A);
    exitTenantContext();
  });

  it('exitTenantContext clears it — this is the fix for the real bug the HTTP plugin hit: enterWith has no built-in "undo"', () => {
    enterTenantContext(TENANT_A);
    expect(hasTenantContext()).toBe(true);
    exitTenantContext();
    expect(hasTenantContext()).toBe(false);
    expect(() => getTenantContext()).toThrow(TenantContextError);
  });

  it('exitTenantContext is a no-op, not an error, when nothing is active — the HTTP plugin calls it unconditionally from onResponse on every request, including ones that never authenticated', () => {
    expect(hasTenantContext()).toBe(false);
    expect(() => exitTenantContext()).not.toThrow();
    expect(hasTenantContext()).toBe(false);
  });

  it('refuses to establish a context with a value that is not a UUID, same guard as withTenantContext', () => {
    expect(() => enterTenantContext('not-a-uuid')).toThrow(TenantContextError);
    expect(hasTenantContext()).toBe(false);
  });

  it('demonstrates the exact production gap this closes: without exitTenantContext, a context set by one "request" is still ambient for whatever runs next on the same continuation', async () => {
    // This is the HTTP keep-alive scenario from tenant-context.ts's own
    // comment, reproduced directly against AsyncLocalStorage rather than
    // through Fastify's inject() — which is what let the real bug pass
    // locally on Windows 10/10 times and still fail in CI on Linux. Two
    // `await`ed steps in the SAME async function, simulating two
    // sequentially handled requests sharing one continuation.
    enterTenantContext(TENANT_A);
    await Promise.resolve(); // yield, same as awaiting between two requests
    expect(hasTenantContext()).toBe(true); // confirms the leak is real without a fix

    exitTenantContext(); // the fix: apps/api's onResponse hook does exactly this
    await Promise.resolve();
    expect(hasTenantContext()).toBe(false); // the next "request" sees a clean slate
  });
});
