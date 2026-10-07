/**
 * P4-10 T1 and the breaker's own state machine — pure, no network,
 * no Anthropic call, deterministic via an injected clock (the same
 * dependency-injectable-clock discipline retry.ts's own
 * sleep/random already follows).
 */
import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError, callThroughBreaker } from '../circuit-breaker.js';

function fakeClock(startAt = 0) {
  let now = startAt;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('CircuitBreaker', () => {
  it('T1: opens within the configured failure threshold, not before', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 1000, now: clock.now });
    breaker.onFailure();
    expect(breaker.getState()).toBe('closed');
    breaker.onFailure();
    expect(breaker.getState()).toBe('closed');
    breaker.onFailure(); // the 3rd consecutive failure
    expect(breaker.getState()).toBe('open');
  });

  it('a success resets the consecutive-failure count, so an isolated failure never accumulates toward opening', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, openDurationMs: 1000 });
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    expect(breaker.getState()).toBe('closed'); // only 1 consecutive failure since the reset
  });

  it('canAttempt is false while open', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 1000 });
    breaker.onFailure();
    expect(breaker.canAttempt()).toBe(false);
  });

  it('promotes open -> half_open once openDurationMs elapses, and canAttempt becomes true again', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 1000, now: clock.now });
    breaker.onFailure();
    expect(breaker.getState()).toBe('open');
    clock.advance(999);
    expect(breaker.getState()).toBe('open');
    clock.advance(1);
    expect(breaker.getState()).toBe('half_open');
    expect(breaker.canAttempt()).toBe(true);
  });

  it('a failed half-open trial re-opens immediately, regardless of the configured threshold', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 5, openDurationMs: 1000, now: clock.now });
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure(); // opens at threshold 5
    expect(breaker.getState()).toBe('open');
    clock.advance(1000);
    expect(breaker.getState()).toBe('half_open');
    breaker.onFailure(); // a SINGLE failed trial call
    expect(breaker.getState()).toBe('open');
  });

  it('a successful trial call while half-open closes the circuit and reports recovery', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 1000, now: clock.now });
    breaker.onFailure();
    clock.advance(1000);
    expect(breaker.getState()).toBe('half_open');
    const outcome = breaker.onSuccess();
    expect(breaker.getState()).toBe('closed');
    expect(outcome.recovered).toBe(true);
  });

  it('a success while ALREADY closed reports recovered: false — only the recovering success should trigger a drain', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 1000 });
    expect(breaker.onSuccess().recovered).toBe(false);
  });
});

describe('callThroughBreaker', () => {
  it('throws CircuitOpenError immediately without ever calling fn when the circuit is open', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 1000 });
    breaker.onFailure();
    const fn = vi.fn();
    await expect(callThroughBreaker(breaker, fn, () => true)).rejects.toThrow(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a provider failure trips the breaker; a non-provider failure (e.g. a malformed response) does not', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 1000 });
    await expect(callThroughBreaker(breaker, () => Promise.reject(new Error('malformed response')), () => false)).rejects.toThrow(
      'malformed response',
    );
    expect(breaker.getState()).toBe('closed'); // isProviderFailure said this one doesn't count
  });

  it('a genuine provider failure trips the breaker open', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 1000 });
    await expect(callThroughBreaker(breaker, () => Promise.reject(new Error('503')), () => true)).rejects.toThrow('503');
    expect(breaker.getState()).toBe('open');
  });

  it('returns recovered: true exactly on the call that closes the circuit', async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 1000, now: clock.now });
    await expect(callThroughBreaker(breaker, () => Promise.reject(new Error('503')), () => true)).rejects.toThrow();
    clock.advance(1000);
    const { recovered } = await callThroughBreaker(breaker, () => Promise.resolve('ok'), () => true);
    expect(recovered).toBe(true);
  });
});
