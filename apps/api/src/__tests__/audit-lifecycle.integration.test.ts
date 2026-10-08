/**
 * P5-09 T1/T2 — "a full alert-to-action flow produces the complete
 * expected audit sequence," against real Postgres and Redis.
 *
 * No playbook can actually SUCCEED against Graph in this environment
 * (no real M365 connection exists anywhere in this repo's own test
 * suite — see graph-access.ts's own doc comment), so T1's own
 * "action completed" step is driven directly through
 * ActionsRepository.markSucceeded rather than a real executePlaybook
 * call — P5-05's own tests already prove execute-action.ts's wiring
 * end to end with a fake Graph client; this file's own job is
 * narrower and different: prove the AUDIT TRAIL itself is complete
 * and correctly attributed at every lifecycle step, which is true
 * regardless of whether the underlying Graph call succeeds.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import pg, { type PoolClient } from 'pg';
import { withTenantContext, ActionsRepository, AuditExportRepository, NotificationDeliveryRepository } from '@sentinel/db';
import { createLogger } from '@sentinel/observability';
import { NotificationDispatcher, dashboardBannerChannel, staticChannelOrder } from '@sentinel/notifications';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
let redis: RedisClientType;
let tenantId: string;
let caseId: string;

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

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();

  const tenantResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ('P5-09 audit lifecycle probe', 'trial') RETURNING id`));
  tenantId = tenantResult.rows[0]!.id;
  const caseResult = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO cases (tenant_id, severity, title, window_start) VALUES ($1, 'critical', 'probe case', now()) RETURNING id`, [tenantId]),
    tenantId,
  );
  caseId = caseResult.rows[0]!.id;
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await redis.quit();
  await pool.end();
});

describe('T1: a full alert-to-action flow produces the complete expected audit sequence', () => {
  it('alert sent -> approval granted -> action started -> action completed, correctly attributed throughout', async () => {
    const actionId = await withTenantContext(tenantId, async () => {
      const actions = new ActionsRepository(pool);
      const action = await actions.proposeAction(caseId, 'revoke_sessions', { userId: 'u1', expectedUpn: 'priya@example.com' }, 'single_user');

      // 1. Alert sent — a real dispatch via the real dashboard_banner
      // channel (P5-01), proving AC1's "alert sent" line is genuinely
      // written by the SAME path a real alert would take, not asserted
      // by calling writeAuditEntryTx by hand.
      const logger = createLogger({ service: 'audit-lifecycle-test' });
      const recorder = new NotificationDeliveryRepository(pool);
      const dispatcher = new NotificationDispatcher({ channels: [dashboardBannerChannel], recorder, channelOrder: staticChannelOrder, logger });
      await dispatcher.dispatch({ tenantId, dedupeKey: `audit-lifecycle:${action.id}`, content: { dashboard_banner: { title: 'Approve revoke_sessions?', actionId: action.id } } });

      // 2. Approval granted — a real human approving.
      await actions.approve(action.id, caseId, 'approver-1');

      // 3. Action started.
      await actions.markExecuting(action.id);

      // 4. Action completed.
      await actions.markSucceeded(action.id);

      return action.id;
    });

    const audit = await asAdmin(
      (c) => c.query(`SELECT actor_type, actor_id, action FROM audit_log WHERE tenant_id = $1 AND subject_id = $2 ORDER BY id ASC`, [tenantId, actionId]),
      tenantId,
    );
    expect(audit.rows).toEqual([
      { actor_type: 'human', actor_id: 'approver-1', action: 'approval_granted' },
      { actor_type: 'system', actor_id: 'sentinel-response', action: 'action_started' },
      { actor_type: 'system', actor_id: 'sentinel-response', action: 'action_completed' },
    ]);

    // AC1's "alert sent" is audited under a DIFFERENT subject (the
    // alert/notification itself, not the action) — found via the SAME
    // export capability AC5 asks for, tying both acceptance criteria
    // together in one real query rather than two disconnected checks.
    const exported = await withTenantContext(tenantId, () => new AuditExportRepository(pool).exportRange(new Date(Date.now() - 60_000), new Date(Date.now() + 60_000)));
    const alertSent = exported.find((e) => e.action === 'alert_sent' && e.subjectId === `audit-lifecycle:${actionId}`);
    expect(alertSent).toMatchObject({ actorType: 'system', subjectType: 'notification' });
  });

  it('T2: a failed action still produces a complete audit record, in the correct order', async () => {
    const actionId = await withTenantContext(tenantId, async () => {
      const actions = new ActionsRepository(pool);
      const action = await actions.proposeAction(caseId, 'revoke_sessions', { userId: 'u2', expectedUpn: 'other@example.com' }, 'single_user');
      await actions.approve(action.id, caseId, 'approver-2');
      await actions.markExecuting(action.id);
      await actions.markFailed(action.id, 'simulated Graph outage', 'Revoke this session manually.');
      return action.id;
    });

    const audit = await asAdmin(
      (c) => c.query(`SELECT actor_type, action, payload FROM audit_log WHERE tenant_id = $1 AND subject_id = $2 ORDER BY id ASC`, [tenantId, actionId]),
      tenantId,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['approval_granted', 'action_started', 'action_failed']);
    expect(audit.rows[2]!.payload).toMatchObject({ error: 'simulated Graph outage', manual_steps: 'Revoke this session manually.' });
  });
});
