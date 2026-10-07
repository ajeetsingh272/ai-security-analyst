/**
 * Exponential backoff with jitter (P4-01 AC2/T2) — "a transient 529
 * [Anthropic's own 'overloaded' status] retries with backoff and
 * eventually succeeds."
 *
 * Full jitter (delay = random(0, cap)), not a fixed or additive
 * jitter scheme: with many concurrent investigations potentially
 * retrying at once (a real provider outage affects every in-flight
 * call, not just one), full jitter is what actually de-correlates
 * their retry timing — the thing jitter exists for in the first
 * place.
 */

export class PermanentError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PermanentError';
  }
}

export interface RetryOptions {
  /** Including the first attempt — maxAttempts: 3 means up to 2 retries. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Decides whether a thrown error is worth retrying at all. A
   * PermanentError is NEVER retried regardless of what this returns —
   * it is the one case this function itself always treats as
   * terminal, since a call site that already knows an error can
   * never succeed should not need its own isRetryable to repeat that. */
  isRetryable: (err: unknown) => boolean;
  /** Overridable for tests — real callers never set this. */
  sleep?: (ms: number) => Promise<void>;
  /** Overridable for tests — makes jitter deterministic. Real callers
   * never set this. */
  random?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full-jitter exponential backoff: attempt 0 (the first retry, after
 * the initial attempt already failed) gets up to baseDelayMs; attempt
 * N gets up to min(maxDelayMs, baseDelayMs * 2^N). */
export function backoffDelayMs(attempt: number, opts: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'random'>): number {
  const cap = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  const random = opts.random ?? Math.random;
  return Math.floor(random() * cap);
}

/**
 * Runs fn, retrying on a retryable failure up to maxAttempts times
 * total. Throws the last error if every attempt fails — a
 * PermanentError immediately (AC3's own "permanent failures route to
 * DLQ... never silently drop a case" starts with this function never
 * pretending a permanent error might still succeed).
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof PermanentError) {
        throw err;
      }
      if (!opts.isRetryable(err) || attempt === opts.maxAttempts - 1) {
        throw err;
      }
      await sleep(backoffDelayMs(attempt, opts));
    }
  }

  // Unreachable (the loop above always returns or throws), but keeps
  // the function's own return type honest without a non-null
  // assertion at the call site.
  throw lastErr;
}
