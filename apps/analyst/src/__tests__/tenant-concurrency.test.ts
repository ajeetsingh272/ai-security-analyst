/**
 * P4-01 AC1: "per-tenant concurrency limits" — a different tenant's
 * own work must never be blocked by one tenant already at its limit.
 */
import { describe, expect, it } from 'vitest';
import { TenantConcurrencyLimiter } from '../tenant-concurrency.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('TenantConcurrencyLimiter', () => {
  it('allows up to `limit` concurrent runs for one tenant', async () => {
    const limiter = new TenantConcurrencyLimiter(2);
    let concurrent = 0;
    let maxConcurrent = 0;
    const gate = deferred<void>();

    const run = () =>
      limiter.run('tenant-a', async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gate.promise;
        concurrent--;
      });

    const r1 = run();
    const r2 = run();
    const r3 = run(); // should queue — limit is 2
    await new Promise((r) => setTimeout(r, 20));

    expect(maxConcurrent).toBe(2);
    gate.resolve();
    await Promise.all([r1, r2, r3]);
  });

  it('a second tenant is never blocked by the first tenant being at its limit', async () => {
    const limiter = new TenantConcurrencyLimiter(1);
    const gateA = deferred<void>();
    const order: string[] = [];

    const pA = limiter.run('tenant-a', async () => {
      order.push('a-start');
      await gateA.promise;
      order.push('a-end');
    });
    const pB = limiter.run('tenant-b', async () => {
      order.push('b-start');
      order.push('b-end');
    });

    await pB; // tenant-b must complete WITHOUT waiting on tenant-a at all
    expect(order).toEqual(['a-start', 'b-start', 'b-end']);

    gateA.resolve();
    await pA;
  });

  it('queued work for the same tenant runs in order once a slot frees up', async () => {
    const limiter = new TenantConcurrencyLimiter(1);
    const order: string[] = [];
    const gate1 = deferred<void>();

    const p1 = limiter.run('tenant-a', async () => {
      order.push('1-start');
      await gate1.promise;
      order.push('1-end');
    });
    const p2 = limiter.run('tenant-a', async () => {
      order.push('2-start');
      order.push('2-end');
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['1-start']); // 2 has not started yet — tenant-a is at its limit

    gate1.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['1-start', '1-end', '2-start', '2-end']);
  });

  it('releases the slot even when the wrapped function throws', async () => {
    const limiter = new TenantConcurrencyLimiter(1);
    await expect(
      limiter.run('tenant-a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // If the slot were not released, this would hang forever.
    const result = await limiter.run('tenant-a', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('totalInFlight reflects currently-running work across all tenants', async () => {
    const limiter = new TenantConcurrencyLimiter(5);
    const gate = deferred<void>();
    expect(limiter.totalInFlight).toBe(0);

    const p = limiter.run('tenant-a', async () => {
      await gate.promise;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(limiter.totalInFlight).toBe(1);

    gate.resolve();
    await p;
    expect(limiter.totalInFlight).toBe(0);
  });

  it('rejects a non-positive limit', () => {
    expect(() => new TenantConcurrencyLimiter(0)).toThrow();
  });
});
