/**
 * P4-01 T2: "A transient 529 retries with backoff and eventually
 * succeeds." Pure unit test — no real Anthropic call, no real sleep
 * (both are injectable precisely so this test can run in
 * milliseconds and assert exact call counts).
 */
import { describe, expect, it, vi } from 'vitest';
import { withRetry, backoffDelayMs, PermanentError } from '../retry.js';

class FakeOverloadedError extends Error {
  readonly status = 529;
}

function alwaysRetryable(): boolean {
  return true;
}

describe('withRetry', () => {
  it('T2: a transient failure (simulated 529) retries with backoff and eventually succeeds', async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const fn = async () => {
      attempts++;
      if (attempts < 3) throw new FakeOverloadedError('overloaded');
      return 'ok';
    };

    const result = await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      isRetryable: alwaysRetryable,
      sleep,
      random: () => 0.5,
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2); // retried after attempt 1 and attempt 2
  });

  it('throws the last error once maxAttempts is exhausted', async () => {
    const sleep = vi.fn(async () => {});
    const fn = async () => {
      throw new FakeOverloadedError('still overloaded');
    };

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, isRetryable: alwaysRetryable, sleep, random: () => 0.5 }),
    ).rejects.toThrow('still overloaded');
    expect(sleep).toHaveBeenCalledTimes(2); // 3 attempts, 2 retries between them
  });

  it('never retries a PermanentError, regardless of isRetryable', async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new PermanentError('malformed, retrying would not help');
    };

    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100, isRetryable: alwaysRetryable, sleep }),
    ).rejects.toThrow(PermanentError);
    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry when isRetryable returns false', async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error('a plain, non-retryable error');
    };

    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100, isRetryable: () => false, sleep }),
    ).rejects.toThrow('a plain, non-retryable error');
    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('succeeds on the first attempt without ever sleeping', async () => {
    const sleep = vi.fn(async () => {});
    const result = await withRetry(async () => 'immediate', {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 100,
      isRetryable: alwaysRetryable,
      sleep,
    });
    expect(result).toBe('immediate');
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially with attempt number, capped at maxDelayMs', () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 2000, random: () => 1 }; // random()=1 -> always the cap itself
    expect(backoffDelayMs(0, opts)).toBe(100); // 100 * 2^0
    expect(backoffDelayMs(1, opts)).toBe(200); // 100 * 2^1
    expect(backoffDelayMs(2, opts)).toBe(400); // 100 * 2^2
    expect(backoffDelayMs(10, opts)).toBe(2000); // capped, not 100 * 2^10
  });

  it('full jitter: delay is always within [0, cap)', () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 2000 };
    for (let attempt = 0; attempt < 6; attempt++) {
      const delay = backoffDelayMs(attempt, opts);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(Math.min(2000, 100 * 2 ** attempt) + 1);
    }
  });
});
