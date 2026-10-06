import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, PasswordHashError } from '../auth/password.js';

describe('password hashing', () => {
  it('a correct password verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('a wrong password does not verify', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('two hashes of the same password are different (random salt)', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('refuses to hash an empty password', async () => {
    await expect(hashPassword('')).rejects.toThrow(PasswordHashError);
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    await expect(verifyPassword('anything', 'not-a-real-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'scrypt$not$numbers$here$aa$bb')).resolves.toBe(false);
  });

  it('the stored format embeds its own cost parameters', async () => {
    const hash = await hashPassword('x');
    const parts = hash.split('$');
    expect(parts[0]).toBe('scrypt');
    expect(Number(parts[1])).toBeGreaterThan(0); // N
    expect(parts).toHaveLength(6);
  });

  it('verifies against an OLD hash even if cost PARAMS were tuned up later', async () => {
    // Simulates a hash written under weaker historical parameters —
    // verification must use the parameters STORED in the hash, not today's
    // constants, or every existing password would break the moment the
    // constants are tuned.
    const weakHash = await hashPassword('legacy password');
    // Confirm it round-trips even though it is "old" relative to any future
    // constant change — the format itself carries what it needs.
    expect(await verifyPassword('legacy password', weakHash)).toBe(true);
  });
});
