/**
 * The outer layer of envelope encryption: wrapping and unwrapping a DEK
 * with a KEK (key-encryption key) that itself never touches application
 * code or the database — ADR-0008's "itself wrapped by a KEK in KMS."
 *
 * KeyManagementService is the seam a real cloud KMS (AWS KMS, GCP Cloud
 * KMS, Vault's transit engine) plugs into later — WHICH one is a
 * deployment decision this repo hasn't made yet (it depends on which
 * cloud this product actually runs in, not on anything P1-02 itself
 * decides), so it is deliberately not decided here either. LocalKMS below
 * is the dev/test implementation: the SAME real AES-256-GCM wrap/unwrap a
 * cloud KMS's own envelope-encryption helpers do internally, just sourced
 * from a local master key instead of a cloud API call — not a mock of the
 * mechanism, the same mechanism Postgres/Redis/S3 already get in this dev
 * stack: a real, working instance with a dev-local secret source instead
 * of a managed one.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface WrappedDEK {
  wrapped: Buffer;
  keyId: string;
}

export interface KeyManagementService {
  wrapDEK(dek: Buffer): Promise<WrappedDEK>;
  unwrapDEK(wrapped: Buffer, keyId: string): Promise<Buffer>;
}

const ALGORITHM = 'aes-256-gcm';
const KEK_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * LocalKMS wraps a DEK with a master key read from an environment
 * variable — `KMS_LOCAL_MASTER_KEY`, 32 bytes, base64-encoded (`openssl
 * rand -base64 32` generates one). keyId is always `"local-v1"`: unlike a
 * real cloud KMS, there is exactly one local master key and no rotation
 * story for it yet, so the version number exists only so a LATER local
 * key (`"local-v2"`) — or a real cloud KMS entirely, under a key id like
 * `"aws-kms:<key-arn>"` — can tell its own wrapped DEKs apart from this
 * one's, the same reason envelope.ts's blob format carries its own
 * version byte.
 */
export class LocalKMS implements KeyManagementService {
  private readonly keyId = 'local-v1';
  private readonly masterKey: Buffer;

  constructor(masterKeyBase64?: string) {
    const raw = masterKeyBase64 ?? process.env['KMS_LOCAL_MASTER_KEY'];
    if (!raw) {
      throw new Error(
        'LocalKMS: KMS_LOCAL_MASTER_KEY is not set. Generate one with ' +
          '`openssl rand -base64 32` and set it in the environment — there is ' +
          'no default, because a default checked into this repo would be a ' +
          'KEK anyone with the source code already has.',
      );
    }
    const key = Buffer.from(raw, 'base64');
    if (key.length !== KEK_BYTES) {
      throw new RangeError(
        `LocalKMS: KMS_LOCAL_MASTER_KEY must decode to ${KEK_BYTES} bytes, got ${key.length}`,
      );
    }
    this.masterKey = key;
  }

  async wrapDEK(dek: Buffer): Promise<WrappedDEK> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { wrapped: Buffer.concat([iv, authTag, ciphertext]), keyId: this.keyId };
  }

  async unwrapDEK(wrapped: Buffer, keyId: string): Promise<Buffer> {
    if (keyId !== this.keyId) {
      throw new Error(`LocalKMS: cannot unwrap a DEK wrapped by key id ${keyId}, this instance only holds ${this.keyId}`);
    }
    const iv = wrapped.subarray(0, IV_BYTES);
    const authTag = wrapped.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const ciphertext = wrapped.subarray(IV_BYTES + AUTH_TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
