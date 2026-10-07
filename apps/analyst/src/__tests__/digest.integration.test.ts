/**
 * P4-12: the cross-tenant daily digest sweep against real Postgres —
 * proving `generateDailyDigests` finds and logs every tenant's own
 * dismissals for the day, not just one tenant's.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import pg, { type Pool } from 'pg';
import { createLogger } from '@sentinel/observability';
import { withTenantContext, CasesRepository } from '@sentinel/db';
import { generateDailyDigests } from '../digest.js';

function capturingLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const destination = new Writable({
    write(chunk, _enc, callback) {
      lines.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  return { logger: createLogger({ service: 'sentinel-analyst-test', destination }), lines };
}

const pool: Pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });

async function asAdmin<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sentinel_app');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function createTenantWithDismissedCase(reason: string): Promise<{ tenantId: string; caseId: string }> {
  const tenantId = await asAdmin(async (c) => {
    const { rows } = await c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ($1, 'trial') RETURNING id`, [
      `P4-12 digest sweep probe ${Date.now()}`,
    ]);
    return rows[0]!.id;
  });
  const caseId = await asAdmin(async (c) => {
    await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count) VALUES ($1, 'low', 'probe', now(), 1) RETURNING id`,
      [tenantId],
    );
    return rows[0]!.id;
  });
  await withTenantContext(tenantId, () => new CasesRepository(pool).recordAiDismissal(caseId, reason));
  return { tenantId, caseId };
}

async function deleteTenant(tenantId: string): Promise<void> {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
}

const cleanupTenants: string[] = [];
afterAll(async () => {
  for (const tenantId of cleanupTenants) await deleteTenant(tenantId).catch(() => {});
  await pool.end();
});

describe('generateDailyDigests', () => {
  it("sweeps every tenant's own dismissals for the day, not just one", async () => {
    const { tenantId: tenantA, caseId: caseA } = await createTenantWithDismissedCase('reason A');
    const { tenantId: tenantB, caseId: caseB } = await createTenantWithDismissedCase('reason B');
    cleanupTenants.push(tenantA, tenantB);

    const { logger, lines } = capturingLogger();

    await generateDailyDigests(pool, new Date(Date.now() - 60_000), logger);

    const lineA = lines.find((l) => l.tenant_id === tenantA);
    const lineB = lines.find((l) => l.tenant_id === tenantB);
    expect(lineA?.summary).toContain('reason A');
    expect(lineB?.summary).toContain('reason B');
    expect(caseA).not.toBe(caseB);
  });
});
