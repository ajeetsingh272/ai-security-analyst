/**
 * Envelope encryption's inner layer — the DEK (data encryption key) itself,
 * and what it does to a plaintext blob. The outer layer (wrapping the DEK
 * with a KEK) is kms.ts; this file never sees a KEK at all, deliberately —
 * it has no idea the DEK it was handed is wrapped by anything, which is
 * what lets it be tested with a plain random key and nothing else.
 *
 * ADR-0008 point 4: "Connector credentials and OAuth refresh tokens are
 * encrypted with a per-tenant DEK, itself wrapped by a KEK in KMS. A stolen
 * database dump without KMS access yields nothing usable." This is the
 * "encrypted with a per-tenant DEK" half.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const DEK_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM's recommended nonce length — 16 bytes works too, but 12 avoids an internal re-derivation step the GCM spec defines for other lengths.
const AUTH_TAG_BYTES = 16;

/** A fresh, random 256-bit DEK. One per tenant (ADR-0008) — see kms.ts's
 * TenantCredentialVault for where that "one per tenant" rule actually
 * lives; this function has no opinion about reuse, it just makes a key. */
export function generateDEK(): Buffer {
  return randomBytes(DEK_BYTES);
}

/**
 * Encrypts `plaintext` with `dek`, returning a single self-describing
 * blob: `[1-byte version][12-byte IV][16-byte auth tag][ciphertext]`.
 *
 * A version byte, not just IV+tag+ciphertext, for the same reason
 * password.ts's stored hash format is `scrypt$N$r$p$...` rather than a
 * bare hash: AES-256-GCM is today's choice, not a promise it stays the
 * only one a stored blob can ever decode with — a future version can
 * change the algorithm without needing a migration to reinterpret every
 * already-stored blob's bytes.
 */
export function encryptWithDEK(dek: Buffer, plaintext: Buffer): Buffer {
  if (dek.length !== DEK_BYTES) {
    throw new RangeError(`encryptWithDEK: dek must be ${DEK_BYTES} bytes, got ${dek.length}`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([1]), iv, authTag, ciphertext]);
}

/** The inverse of encryptWithDEK. Throws (node:crypto's own
 * "Unsupported state or unable to authenticate data") if `dek` is wrong or
 * `blob` was tampered with — GCM's auth tag makes silent corruption
 * impossible to miss, which is the entire point of authenticated
 * encryption over plain AES-CBC here. */
export function decryptWithDEK(dek: Buffer, blob: Buffer): Buffer {
  if (dek.length !== DEK_BYTES) {
    throw new RangeError(`decryptWithDEK: dek must be ${DEK_BYTES} bytes, got ${dek.length}`);
  }
  const version = blob[0];
  if (version !== 1) {
    throw new Error(`decryptWithDEK: unsupported envelope version ${version}`);
  }
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const authTag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = blob.subarray(1 + IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, dek, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
