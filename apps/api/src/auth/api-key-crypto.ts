/**
 * P6-09: generating and verifying a public API key. Unlike a password
 * (password.ts, a slow KDF against a human-chosen, low-entropy
 * secret), a generated key is already a high-entropy random value, so
 * a fast cryptographic hash (SHA-256) is the correct, standard choice
 * here — a slow KDF would only add latency to every single API
 * request with no additional protection against brute force (there is
 * nothing to brute-force: the key space is 2^192).
 */
import { randomBytes, createHash } from 'node:crypto';

const KEY_PREFIX = 'sk_live_';
/** How much of the raw key is kept visible (hashed form is stored,
 * never the rest) so a tenant can tell two of their own keys apart in
 * a list without either party ever seeing the full secret again. */
const VISIBLE_PREFIX_LENGTH = KEY_PREFIX.length + 8;

export interface GeneratedApiKey {
  /** Shown to the caller exactly once, at creation. Never stored. */
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(24).toString('base64url');
  const rawKey = `${KEY_PREFIX}${secret}`;
  return {
    rawKey,
    keyPrefix: rawKey.slice(0, VISIBLE_PREFIX_LENGTH),
    keyHash: hashApiKey(rawKey),
  };
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}
