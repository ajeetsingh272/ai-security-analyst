/**
 * P1-02 T2 — "Stored credentials are unreadable without the KMS key" —
 * plus the supporting unit coverage for envelope.ts/kms.ts. All pure: no
 * database connection, no network. The database-backed half (DEK
 * get-or-create, concurrent-creation race) is
 * tenant-credential-vault.integration.test.ts.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateDEK, encryptWithDEK, decryptWithDEK } from '../crypto/envelope.js';
import { LocalKMS } from '../crypto/kms.js';

describe('envelope encryption (DEK layer)', () => {
  it('round-trips plaintext through encrypt then decrypt', () => {
    const dek = generateDEK();
    const plaintext = Buffer.from(JSON.stringify({ refreshToken: 'super-secret-token' }), 'utf8');

    const blob = encryptWithDEK(dek, plaintext);
    const decrypted = decryptWithDEK(dek, blob);

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('produces a different ciphertext each time (random IV), even for identical plaintext', () => {
    const dek = generateDEK();
    const plaintext = Buffer.from('identical input', 'utf8');

    const blobA = encryptWithDEK(dek, plaintext);
    const blobB = encryptWithDEK(dek, plaintext);

    expect(blobA.equals(blobB)).toBe(false);
  });

  it('T2 core claim: decrypting with the WRONG dek fails rather than returning garbage silently', () => {
    const realDek = generateDEK();
    const wrongDek = generateDEK();
    const blob = encryptWithDEK(realDek, Buffer.from('secret', 'utf8'));

    // GCM's auth tag makes a wrong key a hard failure, not a successful
    // decrypt into corrupted bytes — this IS "unreadable without the key",
    // not merely "produces nonsense if you guess wrong."
    expect(() => decryptWithDEK(wrongDek, blob)).toThrow();
  });

  it('rejects a tampered ciphertext rather than silently decrypting corrupted data', () => {
    const dek = generateDEK();
    const blob = encryptWithDEK(dek, Buffer.from('secret', 'utf8'));
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 0xff; // flip a bit in the ciphertext

    expect(() => decryptWithDEK(dek, tampered)).toThrow();
  });

  it('rejects an unrecognised envelope version rather than guessing a layout', () => {
    const dek = generateDEK();
    const blob = encryptWithDEK(dek, Buffer.from('secret', 'utf8'));
    blob[0] = 99;

    expect(() => decryptWithDEK(dek, blob)).toThrow(/unsupported envelope version/);
  });
});

describe('LocalKMS (KEK layer)', () => {
  const masterKeyA = randomBytes(32).toString('base64');
  const masterKeyB = randomBytes(32).toString('base64');

  it('round-trips a DEK through wrapDEK then unwrapDEK', async () => {
    const kms = new LocalKMS(masterKeyA);
    const dek = generateDEK();

    const { wrapped, keyId } = await kms.wrapDEK(dek);
    const unwrapped = await kms.unwrapDEK(wrapped, keyId);

    expect(unwrapped.equals(dek)).toBe(true);
  });

  it('T2 core claim, at the KEK layer: a DIFFERENT master key cannot unwrap a DEK it did not wrap', async () => {
    const kmsA = new LocalKMS(masterKeyA);
    const kmsB = new LocalKMS(masterKeyB);
    const dek = generateDEK();

    const { wrapped, keyId } = await kmsA.wrapDEK(dek);

    // Same keyId string ("local-v1") on both instances — by design, there
    // is only one local key version — so this is specifically proving
    // that POSSESSING THE WRAPPED BYTES is not enough; the actual master
    // key material is what's missing, which is the realistic "stolen
    // database dump" scenario ADR-0008 describes: the attacker has
    // wrapped_dek from Postgres, but not KMS_LOCAL_MASTER_KEY from
    // wherever that's actually kept (never the database).
    await expect(kmsB.unwrapDEK(wrapped, keyId)).rejects.toThrow();
  });

  it('refuses to construct without a master key, rather than silently using an insecure default', () => {
    const originalEnv = process.env['KMS_LOCAL_MASTER_KEY'];
    delete process.env['KMS_LOCAL_MASTER_KEY'];
    try {
      expect(() => new LocalKMS()).toThrow(/KMS_LOCAL_MASTER_KEY/);
    } finally {
      if (originalEnv !== undefined) process.env['KMS_LOCAL_MASTER_KEY'] = originalEnv;
    }
  });

  it('rejects a master key that is not 32 bytes once base64-decoded', () => {
    const tooShort = randomBytes(16).toString('base64');
    expect(() => new LocalKMS(tooShort)).toThrow(/32 bytes/);
  });
});

describe('full envelope: DEK + KEK together (what actually protects connectors.credentials)', () => {
  it('a stolen database dump (wrapped_dek + encrypted credentials, no master key) yields nothing usable', async () => {
    const realMasterKey = randomBytes(32).toString('base64');
    const kms = new LocalKMS(realMasterKey);

    // The real write path: generate a DEK, wrap it, encrypt the real
    // credentials with it — exactly what TenantCredentialVault does,
    // reproduced here at the pure-function level so this test needs no
    // database at all.
    const dek = generateDEK();
    const { wrapped: wrappedDek, keyId } = await kms.wrapDEK(dek);
    const credentials = { refreshToken: 'eyJ...a-real-looking-m365-refresh-token', scope: 'ActivityFeed.Read' };
    const encryptedCredentials = encryptWithDEK(dek, Buffer.from(JSON.stringify(credentials), 'utf8'));

    // The attacker's view: a Postgres dump gives them connectors.credentials
    // (encryptedCredentials) and tenant_deks.wrapped_dek (wrappedDek) —
    // both BYTEA columns in the SAME database — but the KMS master key
    // lives outside Postgres entirely (an env var / a real KMS's own
    // access control), so it is NOT in this dump.
    const attackerKms = new LocalKMS(randomBytes(32).toString('base64')); // attacker does not have the real key

    await expect(attackerKms.unwrapDEK(wrappedDek, keyId)).rejects.toThrow();
    // Even if the attacker tried every byte of ciphertext as a "dek" guess
    // directly against the credentials blob (skipping the KEK layer
    // entirely), GCM's auth tag still rejects anything but the exact
    // 32-byte key that encrypted it:
    const guessedDek = randomBytes(32);
    expect(() => decryptWithDEK(guessedDek, encryptedCredentials)).toThrow();
  });
});
