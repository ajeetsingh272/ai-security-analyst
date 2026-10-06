/**
 * Password hashing using Node's built-in `scrypt` — no extra dependency,
 * which matters for a function every sign-in and sign-up calls: one fewer
 * native binding to keep building correctly across platforms and Node
 * versions. scrypt is deliberately memory-hard, which is the property that
 * makes brute-forcing a stolen hash expensive on commodity GPU/ASIC
 * hardware, unlike a fast general-purpose hash (SHA-256, MD5) applied
 * directly to a password.
 *
 * Stored format: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>` — the cost
 * parameters travel WITH the hash, not just in this file's constants. If the
 * constants below are ever tuned up (as they should be, periodically, as
 * hardware gets faster), an OLD hash verifies correctly against its OWN
 * recorded parameters rather than against whatever today's constants happen
 * to be — otherwise a parameter bump would silently invalidate every
 * existing password.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Not `promisify(scryptCallback)`: node:crypto's `scrypt` has two overloads
// (with and without an options object), and util.promisify's typings only
// resolve cleanly against one of them, rejecting the 4-argument call this
// file needs. A small explicit wrapper is less surprising than fighting
// that overload resolution.
function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/** N=2^17, r=8, p=1 — OWASP's current baseline for scrypt, using
 * approximately 128 MiB (`128 * N * r` bytes). Costs roughly 100-300ms on
 * typical hardware, which is deliberate: slow enough to matter for an
 * attacker trying billions of guesses, fast enough that a real sign-in does
 * not feel broken.
 *
 * `maxmem` has to be set explicitly and above that 128 MiB, or Node's scrypt
 * throws "memory limit exceeded" — its default cap is 32 MiB, well under
 * what OWASP's own baseline needs. Caught by this file's own test suite:
 * `hashPassword` failed on the very first real call. Twice the requirement,
 * for headroom against the parameters moving up later without someone also
 * remembering to raise this number by hand at the same time. */
const PARAMS = { N: 2 ** 17, r: 8, p: 1, keyLength: 64 };
const MAXMEM = 128 * PARAMS.N * PARAMS.r * 2;
const SALT_LENGTH = 16;

export class PasswordHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordHashError';
  }
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0) {
    throw new PasswordHashError('Refusing to hash an empty password.');
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, PARAMS.keyLength, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: MAXMEM,
  });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verifies a password against a stored hash. Returns false for any
 * malformed or unrecognised hash rather than throwing — a corrupted or
 * future-format hash in the database should fail a login attempt, not crash
 * the request handling it, and the caller treats "false" identically
 * whether the password was wrong or the hash was unreadable; both outcomes
 * are "this credential does not verify."
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const expectedHex = parts[5];
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (!salt || !expectedHex) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let actual: Buffer;
  try {
    // Sized from THIS hash's own N/r, not the current MAXMEM constant — a
    // hash written under different (e.g. later-raised) parameters than
    // today's PARAMS must still be able to verify, which means the memory
    // ceiling has to scale with what the stored hash actually needs, not
    // with whatever today's constants happen to require.
    actual = await scrypt(password, Buffer.from(salt, 'hex'), expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
  } catch {
    // scrypt throws if N/r/p are out of range (e.g. a corrupted hash) —
    // treated the same as "did not verify", not surfaced as a 500.
    return false;
  }

  // timingSafeEqual requires equal-length buffers; comparing length first is
  // not itself a timing leak worth worrying about — it leaks nothing beyond
  // "the stored hash format", which is public information (visible in this
  // very file).
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
