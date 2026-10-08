import { describe, expect, it } from 'vitest';
import { executePlaybook } from '../executor.js';
import { FakeGraphClient } from './fake-graph-client.js';

describe('disable_user', () => {
  it('executes against a matching premise', async () => {
    const graph = new FakeGraphClient();
    graph.users.set('u1', { userPrincipalName: 'priya@example.com', accountEnabled: true });

    const result = await executePlaybook('disable_user', graph, { userId: 'u1', expectedUpn: 'priya@example.com' });
    expect(result).toEqual({ kind: 'executed', outcome: { ok: true } });
    expect(graph.users.get('u1')!.accountEnabled).toBe(false);
  });

  it('T3: refuses to execute when the target no longer matches the premise', async () => {
    const graph = new FakeGraphClient();
    graph.users.set('u1', { userPrincipalName: 'someone-else@example.com', accountEnabled: true });

    const result = await executePlaybook('disable_user', graph, { userId: 'u1', expectedUpn: 'priya@example.com' });
    expect(result.kind).toBe('premise_mismatch');
    // Never touched Graph to mutate anything once the premise failed.
    expect(graph.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(graph.users.get('u1')!.accountEnabled).toBe(true);
  });

  it('T3: refuses when the target user no longer exists at all', async () => {
    const graph = new FakeGraphClient();
    const result = await executePlaybook('disable_user', graph, { userId: 'gone', expectedUpn: 'priya@example.com' });
    expect(result).toEqual({ kind: 'premise_mismatch', reason: 'user gone no longer exists' });
  });

  it('T2: executing twice disables once — the second run sees it already disabled and makes no second PATCH', async () => {
    const graph = new FakeGraphClient();
    graph.users.set('u1', { userPrincipalName: 'priya@example.com', accountEnabled: true });
    const target = { userId: 'u1', expectedUpn: 'priya@example.com' };

    await executePlaybook('disable_user', graph, target);
    const patchCallsAfterFirst = graph.calls.filter((c) => c.method === 'PATCH').length;
    await executePlaybook('disable_user', graph, target);
    const patchCallsAfterSecond = graph.calls.filter((c) => c.method === 'PATCH').length;

    expect(patchCallsAfterFirst).toBe(1);
    expect(patchCallsAfterSecond).toBe(1); // no second PATCH
    expect(graph.users.get('u1')!.accountEnabled).toBe(false);
  });

  it('a total Graph outage fails at the premise check, never reaching execute() at all', async () => {
    const graph = new FakeGraphClient();
    graph.users.set('u1', { userPrincipalName: 'priya@example.com', accountEnabled: true });
    graph.failAllWith = 503;

    const result = await executePlaybook('disable_user', graph, { userId: 'u1', expectedUpn: 'priya@example.com' });
    expect(result.kind).toBe('premise_mismatch');
    expect((result as { reason: string }).reason).toContain('unexpected Graph response 503');
  });

  it('T4: the premise checks out, but the mutating call itself fails — a recoverable failure with manual steps, not a thrown error', async () => {
    const graph = new FakeGraphClient();
    graph.users.set('u1', { userPrincipalName: 'priya@example.com', accountEnabled: true });
    graph.failMutationsWith = 503;

    const result = await executePlaybook('disable_user', graph, { userId: 'u1', expectedUpn: 'priya@example.com' });
    expect(result).toEqual({
      kind: 'executed',
      outcome: { ok: false, recoverable: true, manualSteps: expect.stringContaining('u1'), error: expect.stringContaining('503') },
    });
    expect(graph.users.get('u1')!.accountEnabled).toBe(true); // never actually mutated
  });
});

describe('revoke_sessions', () => {
  it('executes and is naturally idempotent (Graph itself has no "already revoked" state)', async () => {
    const graph = new FakeGraphClient();
    graph.users.set('u1', { userPrincipalName: 'priya@example.com', accountEnabled: true });

    const target = { userId: 'u1', expectedUpn: 'priya@example.com' };
    const first = await executePlaybook('revoke_sessions', graph, target);
    const second = await executePlaybook('revoke_sessions', graph, target);
    expect(first).toEqual({ kind: 'executed', outcome: { ok: true } });
    expect(second).toEqual({ kind: 'executed', outcome: { ok: true } });
  });
});

describe('delete_inbox_rule', () => {
  it('executes against a matching rule', async () => {
    const graph = new FakeGraphClient();
    graph.rules.set('r1', { displayName: 'Forward to external' });

    const result = await executePlaybook('delete_inbox_rule', graph, { userId: 'u1', ruleId: 'r1', expectedRuleName: 'Forward to external' });
    expect(result).toEqual({ kind: 'executed', outcome: { ok: true } });
    expect(graph.rules.has('r1')).toBe(false);
  });

  it('T3: refuses when the rule id now points at a DIFFERENT rule than the case\'s premise', async () => {
    const graph = new FakeGraphClient();
    graph.rules.set('r1', { displayName: 'A totally different, legitimate rule' });

    const result = await executePlaybook('delete_inbox_rule', graph, { userId: 'u1', ruleId: 'r1', expectedRuleName: 'Forward to external' });
    expect(result.kind).toBe('premise_mismatch');
    expect(graph.rules.has('r1')).toBe(true);
  });

  it('T2: deleting an already-deleted rule (404) is treated as success, not a failure', async () => {
    const graph = new FakeGraphClient();
    const result = await executePlaybook('delete_inbox_rule', graph, { userId: 'u1', ruleId: 'already-gone', expectedRuleName: 'anything' });
    expect(result).toEqual({ kind: 'executed', outcome: { ok: true } });
  });
});

describe('force_password_reset', () => {
  it('T2: executing twice sets the flag once', async () => {
    const graph = new FakeGraphClient();
    graph.users.set('u1', { userPrincipalName: 'priya@example.com', accountEnabled: true });
    const target = { userId: 'u1', expectedUpn: 'priya@example.com' };

    await executePlaybook('force_password_reset', graph, target);
    await executePlaybook('force_password_reset', graph, target);
    expect(graph.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });
});

describe('block_ip / isolate_device (no automated backend)', () => {
  it('T4: block_ip always returns a recoverable manual-steps failure, honestly', async () => {
    const graph = new FakeGraphClient();
    const result = await executePlaybook('block_ip', graph, { ipAddress: '203.0.113.7' });
    expect(result).toEqual({
      kind: 'executed',
      outcome: { ok: false, recoverable: true, manualSteps: expect.stringContaining('203.0.113.7'), error: expect.any(String) },
    });
  });

  it('T4: isolate_device always returns a recoverable manual-steps failure, honestly', async () => {
    const graph = new FakeGraphClient();
    const result = await executePlaybook('isolate_device', graph, { deviceId: 'device-123' });
    expect(result).toEqual({
      kind: 'executed',
      outcome: { ok: false, recoverable: true, manualSteps: expect.stringContaining('device-123'), error: expect.any(String) },
    });
  });
});

describe('executor', () => {
  it('returns unknown_playbook for an id not in the registry, rather than throwing', async () => {
    const result = await executePlaybook('not_a_real_playbook', new FakeGraphClient(), {});
    expect(result).toEqual({ kind: 'unknown_playbook' });
  });
});
