/**
 * P6-07 T1: "report generates correctly from a seeded week" — against a
 * real local Postgres, not mocked. Run via `pnpm test:integration`
 * (requires `pnpm dev:stack && pnpm db:migrate` first), mirroring
 * scan.integration.test.ts's own `asAdmin` seeding pattern.
 */
import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { generateWeeklyReport, type WeeklyReportData } from '../weekly-report.js';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });

async function asAdmin<T>(fn: (client: PoolClient) => Promise<T>, scopedTenantId?: string): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sentinel_app');
    if (scopedTenantId) await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', scopedTenantId]);
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

async function seedCase(tenantId: string, severity: string, title: string, daysAgo: number): Promise<string> {
  return asAdmin(async (client) => {
    const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count, entity_ids, created_at)
       VALUES ($1, $2, $3, $4, 1, ARRAY[$5]::text[], $4) RETURNING id`,
      [tenantId, severity, title, createdAt, randomUUID()],
    );
    const caseId = rows[0]!.id;
    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason, occurred_at)
       VALUES ($1, $2, NULL, 'open', 'system', 'correlate', 'first signal clustered', $3)`,
      [tenantId, caseId, createdAt],
    );
    return caseId;
  }, tenantId);
}

async function seedAction(tenantId: string, caseId: string, status: string, daysAgo: number): Promise<void> {
  await asAdmin(async (client) => {
    const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO actions (tenant_id, case_id, playbook, target, blast_radius, status, created_at)
       VALUES ($1, $2, 'disable_account', '{}'::jsonb, 'low', $3, $4)`,
      [tenantId, caseId, status, createdAt],
    );
  }, tenantId);
}

async function seedConnector(tenantId: string, kind: string, status: string): Promise<void> {
  await asAdmin(async (client) => {
    await client.query(`INSERT INTO connectors (tenant_id, kind, status) VALUES ($1, $2, $3)`, [tenantId, kind, status]);
  }, tenantId);
}

async function makeTenant(name: string): Promise<string> {
  const tenantId = randomUUID();
  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, name, 'trial']));
  return tenantId;
}

const createdTenantIds: string[] = [];

afterAll(async () => {
  for (const tenantId of createdTenantIds) {
    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  }
  await pool.end();
});

describe('generateWeeklyReport', () => {
  it('T1: summarizes a seeded week — serious cases, a failed action, and a degraded connector', async () => {
    const tenantId = await makeTenant('P6-07 probe tenant — active week');
    createdTenantIds.push(tenantId);

    const criticalCaseId = await seedCase(tenantId, 'critical', 'Impossible travel sign-in', 2);
    await seedCase(tenantId, 'low', 'Routine password reset', 3);
    await seedAction(tenantId, criticalCaseId, 'failed', 2);
    await seedAction(tenantId, criticalCaseId, 'succeeded', 2);
    await seedConnector(tenantId, 'm365', 'degraded');

    const windowEnd = new Date();
    const report = await generateWeeklyReport(pool, tenantId, windowEnd);

    expect(report.tenantId).toBe(tenantId);
    expect(report.isQuiet).toBe(false);
    expect(report.headline).toMatch(/1 thing/i);
    // A failed action outranks a degraded connector in pickOneImprovement's
    // own priority order (weekly-report.ts) — assert that priority held.
    expect(report.oneImprovement).toMatch(/1 action/i);
    expect(report.oneImprovement).not.toMatch(/Reconnect/i);

    const data = report.data as WeeklyReportData;
    expect(data.totalCases).toBe(2);
    expect(data.bySeverity['critical']).toBe(1);
    expect(data.bySeverity['low']).toBe(1);
    expect(data.actionsByStatus['failed']).toBe(1);
    expect(data.actionsByStatus['succeeded']).toBe(1);
    expect(data.topCase?.severity).toBe('critical');
  });

  it('T2: a genuinely quiet week (no cases, no actions, no degraded connectors) produces an honest, non-padded report', async () => {
    const tenantId = await makeTenant('P6-07 probe tenant — quiet week');
    createdTenantIds.push(tenantId);
    await seedConnector(tenantId, 'm365', 'healthy');

    const report = await generateWeeklyReport(pool, tenantId, new Date());

    expect(report.isQuiet).toBe(true);
    expect(report.headline).toMatch(/no activity/i);
    expect(report.oneImprovement).toBeNull();

    const data = report.data as WeeklyReportData;
    expect(data.totalCases).toBe(0);
    expect(data.topCase).toBeNull();
  });

  it("only counts cases and actions inside the report's own 7-day window, not older activity", async () => {
    const tenantId = await makeTenant('P6-07 probe tenant — stale activity');
    createdTenantIds.push(tenantId);
    await seedCase(tenantId, 'critical', 'Old incident, already handled', 30);

    const report = await generateWeeklyReport(pool, tenantId, new Date());

    const data = report.data as WeeklyReportData;
    expect(data.totalCases).toBe(0);
    expect(report.isQuiet).toBe(true);
  });
});
