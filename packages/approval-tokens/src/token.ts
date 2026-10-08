/**
 * ADR-0007's own token construction, verbatim:
 *
 *   payload = { case_id, action_id, tenant_id, approver_id, nonce, exp }
 *   token   = base64url(payload) + "." + HMAC-SHA256(payload, APPROVAL_TOKEN_SECRET)
 *
 * The HMAC is computed over the EXACT base64url-encoded payload STRING
 * that appears before the dot — never over a re-serialization of the
 * decoded object — so there is only ever one byte sequence in question
 * on both the signing and verifying side. Re-encoding `JSON.parse`'d
 * payload before checking the signature would make the check mean
 * "some JSON equivalent to this was once signed," not "exactly these
 * bytes were signed" (key-order-dependent JSON canonicalization bugs
 * are a real, recurring class of signature-bypass — avoided here by
 * simply never re-serializing).
 *
 * Shape/signature/expiry verification (this file) is intentionally
 * separable from single-use enforcement (NonceStore, types.ts) — the
 * ADR requires "GET never mutates" (T5), and burning a nonce is a
 * mutation. `verifyApprovalTokenShape` does no I/O at all and is safe
 * to call from a GET handler; only `verifyAndConsume` touches the
 * NonceStore, and only a POST handler should call it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ApprovalTokenPayload, ApprovalTokenVerifyResult, NonceStore } from './types.js';

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

export function signApprovalToken(payload: ApprovalTokenPayload, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

/** Signature, shape and expiry only — never touches the nonce store.
 * Safe for a GET (confirmation-page) handler; see this file's own
 * doc comment for why that distinction is load-bearing, not stylistic. */
export function verifyApprovalTokenShape(token: string, secret: string, now: Date = new Date()): ApprovalTokenVerifyResult {
  const dotIndex = token.indexOf('.');
  if (dotIndex < 0) return { ok: false, error: 'malformed' };
  const encodedPayload = token.slice(0, dotIndex);
  const providedSignature = token.slice(dotIndex + 1);

  const expectedSignature = sign(encodedPayload, secret);
  const expectedBuf = Buffer.from(expectedSignature, 'base64url');
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(providedSignature, 'base64url');
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, error: 'bad_signature' };
  }

  let payload: ApprovalTokenPayload;
  try {
    const decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      typeof decoded.caseId !== 'string' ||
      typeof decoded.actionId !== 'string' ||
      typeof decoded.tenantId !== 'string' ||
      typeof decoded.approverId !== 'string' ||
      typeof decoded.nonce !== 'string' ||
      typeof decoded.exp !== 'number'
    ) {
      return { ok: false, error: 'malformed' };
    }
    payload = decoded;
  } catch {
    return { ok: false, error: 'malformed' };
  }

  if (payload.exp * 1000 <= now.getTime()) return { ok: false, error: 'expired', payload };

  return { ok: true, payload };
}

/** The mutating, POST-only path: shape/signature/expiry (above) AND
 * single-use enforcement. Fails closed on every error kind, per the
 * ADR's own "invalid, expired, reused or malformed means no action." */
export async function verifyAndConsume(token: string, secret: string, nonceStore: NonceStore, now: Date = new Date()): Promise<ApprovalTokenVerifyResult> {
  const shapeResult = verifyApprovalTokenShape(token, secret, now);
  if (!shapeResult.ok) return shapeResult;

  const firstUse = await nonceStore.burn(shapeResult.payload);
  if (!firstUse) return { ok: false, error: 'reused', payload: shapeResult.payload };

  return shapeResult;
}
