/**
 * P2-10 T4: "Creating a suppression without a reason is rejected."
 *
 * Pure unit test — no real database. `SuppressionsRepository.create`/`renew`
 * check the reason BEFORE ever calling `withTransaction`, so a fake `Pool`
 * that is never actually used is enough to exercise the rejection path; the
 * DB-level CHECK constraint (defence in depth for any other insert path) is
 * proven separately by scripts/check-migrations.sh applying 0006 from empty.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { withTenantContext } from '../tenant-context.js';
import { SuppressionEmptyReasonError, SuppressionsRepository } from '../repositories/suppressions-repository.js';

const fakePool = {} as Pool;
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

describe('SuppressionsRepository reason validation', () => {
  it('rejects create() with an empty reason', async () => {
    await withTenantContext(TENANT_ID, async () => {
      const repo = new SuppressionsRepository(fakePool);
      await expect(
        repo.create({
          ruleId: 'rule-1',
          reason: '',
          createdBy: USER_ID,
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      ).rejects.toThrow(SuppressionEmptyReasonError);
    });
  });

  it('rejects create() with a whitespace-only reason', async () => {
    await withTenantContext(TENANT_ID, async () => {
      const repo = new SuppressionsRepository(fakePool);
      await expect(
        repo.create({
          ruleId: 'rule-1',
          reason: '   ',
          createdBy: USER_ID,
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      ).rejects.toThrow(SuppressionEmptyReasonError);
    });
  });

  it('rejects renew() with an empty reason', async () => {
    await withTenantContext(TENANT_ID, async () => {
      const repo = new SuppressionsRepository(fakePool);
      await expect(
        repo.renew('33333333-3333-3333-3333-333333333333', {
          reason: '',
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      ).rejects.toThrow(SuppressionEmptyReasonError);
    });
  });
});
