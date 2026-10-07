/**
 * Pure unit test — no real database, mirroring
 * suppressions-repository.test.ts's own pattern exactly:
 * `challengeDismissal` checks the reason BEFORE ever calling
 * `withTransaction`, so a fake `Pool` that is never actually used is
 * enough to exercise the rejection path.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { withTenantContext } from '../tenant-context.js';
import { CasesRepository, DismissalChallengeEmptyReasonError, AiDismissalEmptyReasonError } from '../repositories/cases-repository.js';

const fakePool = {} as Pool;
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const CASE_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';

describe('CasesRepository.challengeDismissal reason validation', () => {
  it('rejects an empty reason', async () => {
    await withTenantContext(TENANT_ID, async () => {
      const repo = new CasesRepository(fakePool);
      await expect(repo.challengeDismissal(CASE_ID, USER_ID, '')).rejects.toThrow(
        DismissalChallengeEmptyReasonError,
      );
    });
  });

  it('rejects a whitespace-only reason', async () => {
    await withTenantContext(TENANT_ID, async () => {
      const repo = new CasesRepository(fakePool);
      await expect(repo.challengeDismissal(CASE_ID, USER_ID, '   ')).rejects.toThrow(
        DismissalChallengeEmptyReasonError,
      );
    });
  });
});

describe('CasesRepository.recordAiDismissal reason validation (P4-12 T3)', () => {
  it('rejects an empty reason — checked before withTransaction is ever called', async () => {
    await withTenantContext(TENANT_ID, async () => {
      const repo = new CasesRepository(fakePool);
      await expect(repo.recordAiDismissal(CASE_ID, '')).rejects.toThrow(AiDismissalEmptyReasonError);
    });
  });

  it('rejects a whitespace-only reason', async () => {
    await withTenantContext(TENANT_ID, async () => {
      const repo = new CasesRepository(fakePool);
      await expect(repo.recordAiDismissal(CASE_ID, '   ')).rejects.toThrow(AiDismissalEmptyReasonError);
    });
  });
});
