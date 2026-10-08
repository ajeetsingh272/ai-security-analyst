/**
 * P5-06 T1/T4 — proposeAction's own pre-approval short-circuit,
 * against real Postgres and Redis, with a REAL NotificationDispatcher
 * (dashboard_banner channel, no external credentials needed — see
 * @sentinel/notifications' own P5-01 doc comments) proving T4 for
 * real rather than asserting a mock was called.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import pg, { type PoolClient } from 'pg';
import { withTenantContext, PreApprovalRepository, NotificationDeliveryRepository } from '@sentinel/db';
import { createLogger } from '@sentinel/observability';
import { NotificationDispatcher, dashboardBannerChannel, staticChannelOrder } from '@sentinel/notifications';
import { proposeAction } from '../propose-action.js';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
let redis: RedisClientType;
let tenantId: string;
let caseId: string;
let userId: string;

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

function realDispatcher(): NotificationDispatcher {
  const logger = createLogger({ service: 'propose-action-test' });
  const recorder = withTenantContext(tenantId, () => new NotificationDeliveryRepository(pool));
  return new NotificationDispatcher({ channels: [dashboardBannerChannel], recorder, channelOrder: staticChannelOrder, logger });
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();

  const tenantResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ('P5-06 propose-action probe', 'trial') RETURNING id`));
  tenantId = tenantResult.rows[0]!.id;
  const caseResult = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO cases (tenant_id, severity, title, window_start) VALUES ($1, 'critical', 'probe case', now()) RETURNING id`, [tenantId]),
    tenantId,
  );
  caseId = caseResult.rows[0]!.id;
  const userResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [`propose-probe-${randomUUID()}@example.com`]));
  userId = userResult.rows[0]!.id;
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [userId]));
  await redis.quit();
  await pool.end();
});

describe('proposeAction', () => {
  it('a NOT pre-approved playbook is proposed and left exactly there — no prompt, no execution, because nothing has decided it yet', async () => {
    const action = await proposeAction(pool, undefined, tenantId, caseId, 'revoke_sessions', { userId: 'u1', expectedUpn: 'x@example.com' }, 'single_user');
    expect(action.status).toBe('proposed');

    const audit = await asAdmin((c) => c.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND subject_id = $2`, [tenantId, action.id]), tenantId);
    expect(audit.rows).toHaveLength(0); // nothing decided yet — proposing alone is not an approval
  });

  it('T1: a pre-approved playbook executes immediately with no prompt, and is audited as system-approved', async () => {
    await withTenantContext(tenantId, () => new PreApprovalRepository(pool).grant('block_ip', userId));

    const action = await proposeAction(pool, undefined, tenantId, caseId, 'block_ip', { ipAddress: '203.0.113.11' }, 'single_ip');
    // block_ip has no automated backend (P5-05) — it still auto-APPROVES
    // (no human prompted) and then fails honestly at EXECUTION, which is
    // a materially different thing than never being auto-approved at all.
    expect(action.status).toBe('failed');

    const audit = await asAdmin(
      (c) => c.query(`SELECT action, actor_type, actor_id FROM audit_log WHERE tenant_id = $1 AND subject_id = $2 ORDER BY id ASC`, [tenantId, action.id]),
      tenantId,
    );
    expect(audit.rows).toEqual([
      { action: 'approval_granted', actor_type: 'system', actor_id: 'sentinel-pre-approval' },
      { action: 'action_started', actor_type: 'system', actor_id: 'sentinel-response' },
      { action: 'action_failed', actor_type: 'system', actor_id: 'sentinel-response' },
    ]);
  });

  it('T4: an automatic execution notifies the tenant (dashboard_banner) for real', async () => {
    await withTenantContext(tenantId, () => new PreApprovalRepository(pool).grant('delete_inbox_rule', userId));
    const dispatcher = realDispatcher();

    const action = await proposeAction(pool, dispatcher, tenantId, caseId, 'delete_inbox_rule', { userId: 'u1', ruleId: 'r1', expectedRuleName: 'x' }, 'single_mailbox');

    const delivery = await withTenantContext(tenantId, () => new NotificationDeliveryRepository(pool).listForDedupeKey(`pre-approved-execution:${action.id}`));
    expect(delivery).toHaveLength(1);
    expect(delivery[0]).toMatchObject({ channel: 'dashboard_banner', status: 'sent' });
    expect(delivery[0]!.content).toMatchObject({ title: expect.stringContaining('automatically'), actionId: action.id });
  });

  it('proposing for a playbook with NO dispatcher passed still executes correctly — notification is optional, not load-bearing', async () => {
    await withTenantContext(tenantId, () => new PreApprovalRepository(pool).grant('revoke_sessions', userId));
    const action = await proposeAction(pool, undefined, tenantId, caseId, 'revoke_sessions', { userId: 'u1', expectedUpn: 'x@example.com' }, 'single_user');
    // No M365 connection in this test env — fails at EXECUTION, not at
    // the (successful, prompt-free) approval step.
    expect(action.status).toBe('failed');
  });
});
