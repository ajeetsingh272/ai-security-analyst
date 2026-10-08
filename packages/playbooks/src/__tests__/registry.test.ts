import { describe, expect, it } from 'vitest';
import { PLAYBOOKS, getPlaybook } from '../registry.js';
import { ALL_PLAYBOOK_IDS } from '../types.js';

describe('playbook registry', () => {
  it('T5: every registered playbook declares a non-empty reversal procedure', () => {
    for (const id of ALL_PLAYBOOK_IDS) {
      const playbook = PLAYBOOKS[id];
      expect(playbook.reversalProcedure.trim().length, `${id} must declare a reversal procedure`).toBeGreaterThan(0);
    }
  });

  it('AC1: every registered playbook declares blast radius, required scopes array, and a step-up requirement', () => {
    for (const id of ALL_PLAYBOOK_IDS) {
      const playbook = PLAYBOOKS[id];
      expect(playbook.blastRadius.trim().length, `${id} must declare a blast radius`).toBeGreaterThan(0);
      expect(Array.isArray(playbook.requiredScopes), `${id} must declare requiredScopes as an array`).toBe(true);
      expect(typeof playbook.requiresStepUp, `${id} must declare requiresStepUp as a boolean`).toBe('boolean');
    }
  });

  it('the three destructive playbooks P5-04 names all require step-up', () => {
    expect(PLAYBOOKS.disable_user.requiresStepUp).toBe(true);
    expect(PLAYBOOKS.isolate_device.requiresStepUp).toBe(true);
    expect(PLAYBOOKS.force_password_reset.requiresStepUp).toBe(true);
  });

  it('getPlaybook returns undefined for an unknown id, not a crash', () => {
    expect(getPlaybook('not_a_real_playbook')).toBeUndefined();
  });
});
