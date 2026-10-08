/**
 * P5-04/ADR-0007: "a valid token is necessary but not sufficient for
 * the actions that hurt most." Re-authentication via the SAME
 * password check sign-in already uses (P0-09) — this platform has no
 * SMS/TOTP infrastructure, and a remembered-or-autofilled password is
 * genuinely "usable from a phone in under 30 seconds" (AC3) without
 * inventing a new channel this ticket doesn't need.
 *
 * `DESTRUCTIVE_PLAYBOOKS` is this ticket's own declaration of which
 * playbooks require it — P5-05 owns the REAL playbook registry
 * (apps/analyst/src/playbook-registry.ts's own doc comment already
 * says as much) and should treat this set as something to align with,
 * not duplicate, once it lands; the three names here are ADR-0007's
 * own verbatim list.
 */
import type { Pool } from 'pg';
import { verifyPassword, DUMMY_PASSWORD_HASH } from '../auth/password.js';

export const DESTRUCTIVE_PLAYBOOKS: ReadonlySet<string> = new Set(['disable_user', 'isolate_device', 'force_password_reset']);

export function requiresStepUp(playbook: string): boolean {
  return DESTRUCTIVE_PLAYBOOKS.has(playbook);
}

/** Same timing-safety shape as the sign-in check this mirrors (P0-09,
 * auth-plugin.ts): always calls verifyPassword, real hash or the
 * shared dummy, so a caller cannot distinguish "no such user" from
 * "wrong password" by response time. */
export async function verifyStepUpPassword(pool: Pool, approverId: string, password: string): Promise<boolean> {
  const result = await pool.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [approverId]);
  const hashToCheck = result.rows[0]?.password_hash ?? DUMMY_PASSWORD_HASH;
  return verifyPassword(password, hashToCheck);
}
