/**
 * P4-10 (TG4, constraint C4 on the analyst side): "the provider being
 * down must degrade the product, not stop it." A plain, dependency-
 * injectable (clock) circuit breaker — the same discipline retry.ts's
 * own `withRetry` already follows (sleep/random injectable for
 * deterministic, millisecond-fast tests), applied here to a
 * longer-lived, cross-case state machine instead of a single call's
 * own retry loop.
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive provider failures before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open before allowing one trial call
   * (half-open) to test whether the provider has recovered. */
  openDurationMs: number;
  now?: () => number;
}

export class CircuitOpenError extends Error {
  constructor() {
    super('circuit breaker is open — the LLM provider is currently considered unavailable');
    this.name = 'CircuitOpenError';
  }
}

export interface SuccessOutcome {
  /** True exactly when this success is the one that closed a
   * previously open/half-open circuit — the edge a caller needs to
   * know "recovery just happened, drain the queue now," not merely
   * "the provider is currently healthy" (true on every success while
   * already closed, which would re-trigger draining needlessly). */
  recovered: boolean;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Reads the current state, promoting open -> half_open once
   * `openDurationMs` has elapsed — a read can itself cause this
   * transition, the same way a plain TTL check does, so callers never
   * need to poll a separate timer themselves. */
  getState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.opts.openDurationMs) {
      this.state = 'half_open';
    }
    return this.state;
  }

  /** AC1: whether a call should be attempted right now. False only
   * while fully open; half-open allows exactly the trial calls a
   * caller actually makes through to test recovery. */
  canAttempt(): boolean {
    return this.getState() !== 'open';
  }

  onSuccess(): SuccessOutcome {
    const wasOpenOrHalfOpen = this.state !== 'closed';
    this.consecutiveFailures = 0;
    this.state = 'closed';
    return { recovered: wasOpenOrHalfOpen };
  }

  onFailure(): void {
    this.consecutiveFailures++;
    // A failed trial call while half-open re-opens immediately,
    // regardless of the configured threshold — one failed recovery
    // attempt is already proof the provider is still down.
    if (this.state === 'half_open' || this.consecutiveFailures >= this.opts.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
      this.consecutiveFailures = 0;
    }
  }
}

/**
 * Runs `fn` through `breaker`: throws `CircuitOpenError` immediately
 * without ever calling `fn` if the circuit is open; otherwise calls
 * `fn`, and classifies the outcome via `isProviderFailure` — a
 * malformed-response or grounding failure is a real problem but NOT
 * evidence the PROVIDER itself is unavailable, and must never trip
 * this breaker the way an actual 503/overload does.
 */
export async function callThroughBreaker<T>(
  breaker: CircuitBreaker,
  fn: () => Promise<T>,
  isProviderFailure: (err: unknown) => boolean,
): Promise<{ value: T; recovered: boolean }> {
  if (!breaker.canAttempt()) {
    throw new CircuitOpenError();
  }
  try {
    const value = await fn();
    const { recovered } = breaker.onSuccess();
    return { value, recovered };
  } catch (err) {
    if (isProviderFailure(err)) breaker.onFailure();
    throw err;
  }
}
