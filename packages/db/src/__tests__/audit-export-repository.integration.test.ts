/**
 * P5-09 T4 — against real Postgres: an export contains every entry
 * for the requested date range and nothing outside it.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlPlanePool, withTenantContext, AuditLogWriter, AuditExportRepository } from '../index.js';
import type { Pool } from 'pg';

let pool: Pool;
const PROBE_ACTOR_ID = 'p5-09-export-probe';

beforeAll(() => {
  pool = createControlPlanePool();
});

afterAll(async () => {
  await pool.end();
});

describe('AuditExportRepository.exportRange', () => {
  it('T4: contains every entry inside [from, to) and nothing outside it', async () => {
    const tenantId = randomUUID();
    const writer = withTenantContext(tenantId, () => new AuditLogWriter(pool));

    const before = new Date('2026-01-01T00:00:00.000Z');
    const insideStart = new Date('2026-02-01T00:00:00.000Z');
    const insideMiddle = new Date('2026-02-15T12:00:00.000Z');
    const afterEnd = new Date('2026-03-01T00:00:00.000Z'); // exactly the exclusive upper bound
    const after = new Date('2026-03-15T00:00:00.000Z');

    for (const [label, occurredAt] of [
      ['before', before],
      ['inside-start', insideStart],
      ['inside-middle', insideMiddle],
      ['after-end-boundary', afterEnd],
      ['after', after],
    ] as const) {
      await writer.insert({ actorType: 'system', actorId: PROBE_ACTOR_ID, action: `probe.${label}`, subjectType: 'probe', subjectId: tenantId, occurredAt });
    }

    const exported = await withTenantContext(tenantId, () => new AuditExportRepository(pool).exportRange(insideStart, afterEnd));
    const actions = exported.map((e) => e.action);
    expect(actions).toEqual(['probe.inside-start', 'probe.inside-middle']);
  });

  it('every exported entry carries its real hash (hex), not a serialised Buffer object', async () => {
    const tenantId = randomUUID();
    const writer = withTenantContext(tenantId, () => new AuditLogWriter(pool));
    const occurredAt = new Date('2026-05-01T00:00:00.000Z');
    await writer.insert({ actorType: 'human', actorId: PROBE_ACTOR_ID, action: 'probe.hash-shape', subjectType: 'probe', subjectId: tenantId, occurredAt });

    const [entry] = await withTenantContext(tenantId, () => new AuditExportRepository(pool).exportRange(new Date('2026-04-30T00:00:00.000Z'), new Date('2026-05-02T00:00:00.000Z')));
    expect(entry!.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry!.prevHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a tenant with no entries in range gets an empty export, not an error', async () => {
    const tenantId = randomUUID();
    const exported = await withTenantContext(tenantId, () => new AuditExportRepository(pool).exportRange(new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z')));
    expect(exported).toEqual([]);
  });
});
