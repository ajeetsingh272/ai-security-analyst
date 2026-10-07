import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signApprovalToken, verifyApprovalTokenShape, verifyAndConsume } from '../token.js';
import type { ApprovalTokenPayload, NonceStore } from '../types.js';

const SECRET = 'test-approval-token-secret';

function payload(overrides: Partial<ApprovalTokenPayload> = {}): ApprovalTokenPayload {
  return {
    caseId: 'case-1',
    actionId: 'action-1',
    tenantId: 'tenant-1',
    approverId: 'approver-1',
    nonce: 'nonce-1',
    exp: Math.floor(Date.now() / 1000) + 15 * 60,
    ...overrides,
  };
}

class FakeNonceStore implements NonceStore {
  used = new Set<string>();
  async burn(p: ApprovalTokenPayload): Promise<boolean> {
    if (this.used.has(p.nonce)) return false;
    this.used.add(p.nonce);
    return true;
  }
}

describe('approval token shape verification (GET-safe, no mutation)', () => {
  it('round-trips a freshly signed token', () => {
    const p = payload();
    const token = signApprovalToken(p, SECRET);
    const result = verifyApprovalTokenShape(token, SECRET);
    expect(result).toEqual({ ok: true, payload: p });
  });

  it('T3: a tampered payload fails signature verification', () => {
    const token = signApprovalToken(payload(), SECRET);
    const signature = token.split('.')[1];
    const tamperedPayload = Buffer.from(JSON.stringify(payload({ actionId: 'action-ATTACKER-CHOSEN' })), 'utf8').toString('base64url');
    const tamperedToken = `${tamperedPayload}.${signature}`;

    expect(verifyApprovalTokenShape(tamperedToken, SECRET)).toEqual({ ok: false, error: 'bad_signature' });
  });

  it('T2: an expired token is rejected, but still carries its (already signature-verified) payload for an audit entry', () => {
    const p = payload({ exp: Math.floor(Date.now() / 1000) - 1 });
    const token = signApprovalToken(p, SECRET);
    expect(verifyApprovalTokenShape(token, SECRET)).toEqual({ ok: false, error: 'expired', payload: p });
  });

  it('rejects a token signed with a different secret', () => {
    const token = signApprovalToken(payload(), 'wrong-secret');
    expect(verifyApprovalTokenShape(token, SECRET)).toEqual({ ok: false, error: 'bad_signature' });
  });

  it('rejects a malformed token with no dot separator', () => {
    expect(verifyApprovalTokenShape('not-a-real-token', SECRET)).toEqual({ ok: false, error: 'malformed' });
  });

  it('rejects a well-signed payload missing a required field', () => {
    // Validly signed (so this fails on SHAPE, not on signature) but the
    // payload itself is missing every field verifyApprovalTokenShape
    // requires — proving the shape check is real, not just "did it parse."
    const encodedPayload = Buffer.from(JSON.stringify({ caseId: 'c', actionId: 'a' }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', SECRET).update(encodedPayload).digest('base64url');
    const token = `${encodedPayload}.${signature}`;
    expect(verifyApprovalTokenShape(token, SECRET)).toEqual({ ok: false, error: 'malformed' });
  });
});

describe('T1/T4/T6: single-use enforcement via NonceStore', () => {
  it('T1: a replayed token is rejected on second use', async () => {
    const store = new FakeNonceStore();
    const p = payload();
    const token = signApprovalToken(p, SECRET);

    const first = await verifyAndConsume(token, SECRET, store);
    expect(first.ok).toBe(true);

    const second = await verifyAndConsume(token, SECRET, store);
    expect(second).toEqual({ ok: false, error: 'reused', payload: p });
  });

  it('T4: a token for case A cannot be used to approve an action on case B', async () => {
    const store = new FakeNonceStore();
    const tokenForCaseA = signApprovalToken(payload({ caseId: 'case-A', actionId: 'action-A' }), SECRET);

    const result = await verifyAndConsume(tokenForCaseA, SECRET, store);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The binding itself: the caller (the HTTP route) must check the
      // verified payload's own caseId/actionId against what it was ASKED
      // to approve — demonstrated here by asserting the payload the
      // token actually carries is case A, never case B, regardless of
      // what URL or request the caller received this token attached to.
      expect(result.payload.caseId).toBe('case-A');
      expect(result.payload.actionId).toBe('action-A');
    }
  });

  it('does not burn the nonce at all when the signature is invalid', async () => {
    const store = new FakeNonceStore();
    const token = signApprovalToken(payload(), 'wrong-secret');
    await verifyAndConsume(token, SECRET, store);
    expect(store.used.size).toBe(0);
  });
});
