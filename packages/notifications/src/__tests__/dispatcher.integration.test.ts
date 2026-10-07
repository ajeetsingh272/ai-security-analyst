/**
 * P5-01 T4 against a REAL Postgres — the unit tests
 * (dispatcher.test.ts) prove the failover/retry/paging logic with a
 * fake in-memory recorder; this file proves the two guarantees that
 * only mean something against the real table: duplicate suppression
 * surviving a genuine concurrent race (the migration's own partial
 * unique index, not just an application-level check-then-act), and
 * that a delivered alert's history is actually queryable afterward
 * (AC4), via @sentinel/db's NotificationDeliveryRepository.
 *
 * Mirrors cases-repository.integration.test.ts's own asAdmin/tenant
 * fixture pattern. Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createControlPlanePool, withTenantContext, NotificationDeliveryRepository, NotificationPreferencesRepository } from '@sentinel/db';
import { createLogger } from '@sentinel/observability';
import { NotificationDispatcher } from '../dispatcher.js';
import type { NotificationChannel, NotificationChannelId, DeliveryRecorder, ChannelOrderResolver } from '../types.js';

let pool: Pool;
let tenantId: string;
const logger = createLogger({ service: 'notifications-integration-test' });

async function asAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

beforeAll(async () => {
  pool = createControlPlanePool();
  const result = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ('P5-01 notifications probe', 'trial') RETURNING id`));
  tenantId = result.rows[0]!.id;
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await pool.end();
});

class CountingChannel implements NotificationChannel {
  sendCount = 0;
  constructor(public readonly id: NotificationChannelId) {}
  async send(): Promise<void> {
    this.sendCount++;
  }
}

function realDispatcher(channels: NotificationChannel[], order: NotificationChannelId[]) {
  const recorder: DeliveryRecorder = withTenantContext(tenantId, () => new NotificationDeliveryRepository(pool));
  const channelOrder: ChannelOrderResolver = { resolve: async () => order };
  return new NotificationDispatcher({ channels, recorder, channelOrder, logger, retry: { maxAttempts: 1, baseDelayMs: 1 } });
}

describe('NotificationDispatcher against a real database', () => {
  it('T4: two concurrent dispatches of the same alert deliver on a channel at most once', async () => {
    const channel = new CountingChannel('dashboard_banner');
    const dedupeKey = `race-${randomUUID()}`;
    const notification = { tenantId, dedupeKey, content: { dashboard_banner: { title: 'test' } } };

    // Two dispatches racing for the SAME alert — the application-level
    // alreadySent() check alone cannot serialize this (both could read
    // "not sent yet" before either writes); the migration's own partial
    // unique index is what must make this true regardless.
    await Promise.all([
      realDispatcher([channel], ['dashboard_banner']).dispatch(notification),
      realDispatcher([channel], ['dashboard_banner']).dispatch(notification),
    ]);

    const history = await withTenantContext(tenantId, () => new NotificationDeliveryRepository(pool).listForDedupeKey(dedupeKey));
    const sentRows = history.filter((r) => r.status === 'sent');
    expect(sentRows).toHaveLength(1);
  });

  it('AC4: delivery status is queryable per alert, across channels and attempts', async () => {
    const dedupeKey = `query-${randomUUID()}`;
    const failing = new (class implements NotificationChannel {
      readonly id: NotificationChannelId = 'whatsapp';
      async send(): Promise<void> {
        throw new Error('whatsapp sandbox unreachable');
      }
    })();
    const succeeding = new CountingChannel('slack');

    await realDispatcher([failing, succeeding], ['whatsapp', 'slack']).dispatch({
      tenantId,
      dedupeKey,
      content: { whatsapp: 'wa-text', slack: { blocks: [] } },
    });

    const history = await withTenantContext(tenantId, () => new NotificationDeliveryRepository(pool).listForDedupeKey(dedupeKey));
    expect(history).toHaveLength(2);
    expect(history.find((r) => r.channel === 'whatsapp')).toMatchObject({ status: 'failed', error: expect.stringContaining('sandbox unreachable') });
    expect(history.find((r) => r.channel === 'slack')).toMatchObject({ status: 'sent' });
  });

  it("AC2: a tenant's own channel order is read back from NotificationPreferencesRepository", async () => {
    const customOrder: NotificationChannelId[] = ['email', 'slack', 'whatsapp', 'dashboard_banner'];
    await withTenantContext(tenantId, () => new NotificationPreferencesRepository(pool).setChannelOrder(customOrder));

    const readBack = await withTenantContext(tenantId, () => new NotificationPreferencesRepository(pool).getChannelOrder());
    expect(readBack).toEqual(customOrder);
  });

  it('AC2: a tenant with no stored preference reads back the platform default', async () => {
    const freshTenant = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ('P5-01 default-order probe', 'trial') RETURNING id`));
    const freshTenantId = freshTenant.rows[0]!.id;
    try {
      const order = await withTenantContext(freshTenantId, () => new NotificationPreferencesRepository(pool).getChannelOrder());
      expect(order).toEqual(['whatsapp', 'slack', 'email', 'dashboard_banner']);
    } finally {
      await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [freshTenantId]));
    }
  });
});
