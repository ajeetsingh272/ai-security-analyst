/**
 * Per-tenant concurrency limiting (P4-01 AC1) — at most `limit`
 * investigations run concurrently FOR THE SAME TENANT; a different
 * tenant's work is never blocked by one tenant's own backlog.
 *
 * Deliberately not a library (p-limit et al. limit GLOBAL
 * concurrency, not per-key) — the actual requirement is per-tenant,
 * and a single Map of small counters/queues is the whole
 * implementation this needs.
 */
export class TenantConcurrencyLimiter {
  private readonly running = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly limit: number) {
    if (limit < 1) {
      throw new Error(`TenantConcurrencyLimiter: limit must be >= 1, got ${limit}`);
    }
  }

  /** Runs fn once this tenant has a free slot — blocking (queueing),
   * never dropping or rejecting, which is what makes this limiter
   * also the natural backpressure mechanism for a Kafka consumer's
   * own eachMessage: a message for a tenant already at its limit
   * simply waits here before eachMessage's own promise resolves,
   * which correctly holds that PARTITION's offset uncommitted in the
   * meantime — nothing is skipped or reordered. */
  async run<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(tenantId);
    try {
      return await fn();
    } finally {
      this.release(tenantId);
    }
  }

  /** The number of tenants with at least one investigation in
   * flight right now — exposed for shutdown draining (AC4/T4): a
   * caller needing to wait for every in-flight investigation to
   * finish reads this, not some separate tracking of its own. */
  get activeTenantCount(): number {
    return this.running.size;
  }

  get totalInFlight(): number {
    let total = 0;
    for (const n of this.running.values()) total += n;
    return total;
  }

  private acquire(tenantId: string): Promise<void> {
    const current = this.running.get(tenantId) ?? 0;
    if (current < this.limit) {
      this.running.set(tenantId, current + 1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const queue = this.waiters.get(tenantId) ?? [];
      queue.push(resolve);
      this.waiters.set(tenantId, queue);
    });
  }

  private release(tenantId: string): void {
    const queue = this.waiters.get(tenantId);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) this.waiters.delete(tenantId);
      // Slot count stays the same — handed directly to the next waiter,
      // never dropped to 0 and reacquired, which would let an unrelated
      // tenant's own acquire() race in ahead of an already-queued waiter.
      next();
      return;
    }
    const current = this.running.get(tenantId) ?? 0;
    if (current <= 1) {
      this.running.delete(tenantId);
    } else {
      this.running.set(tenantId, current - 1);
    }
  }
}
