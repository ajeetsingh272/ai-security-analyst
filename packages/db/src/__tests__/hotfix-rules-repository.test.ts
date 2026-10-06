/**
 * Pure unit test — no real database. `HotfixRulesRepository.create`
 * checks the reason BEFORE ever touching the pool, so a fake `Pool`
 * that is never actually used is enough to exercise the rejection path.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { HotfixRuleEmptyReasonError, HotfixRulesRepository } from '../repositories/hotfix-rules-repository.js';

const fakePool = {} as Pool;
const USER_ID = '22222222-2222-2222-2222-222222222222';

describe('HotfixRulesRepository reason validation', () => {
  it('rejects create() with an empty reason', async () => {
    const repo = new HotfixRulesRepository(fakePool);
    await expect(
      repo.create({ ruleId: 'rule-1', ruleTitle: 'Test rule', ruleYaml: 'id: rule-1', reason: '', createdBy: USER_ID }),
    ).rejects.toThrow(HotfixRuleEmptyReasonError);
  });

  it('rejects create() with a whitespace-only reason', async () => {
    const repo = new HotfixRulesRepository(fakePool);
    await expect(
      repo.create({ ruleId: 'rule-1', ruleTitle: 'Test rule', ruleYaml: 'id: rule-1', reason: '   ', createdBy: USER_ID }),
    ).rejects.toThrow(HotfixRuleEmptyReasonError);
  });
});
