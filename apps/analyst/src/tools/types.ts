/**
 * The shared shape every investigation tool (query_events,
 * get_entity_baseline, lookup_threat_intel, get_case_history) is built on
 * top of (P4-02). Three concerns that have nothing to do with any one
 * tool's own data source belong here instead of being re-implemented four
 * times: a bounded result size with an explicit truncation marker (never a
 * silent cut), a timeout that always resolves to a structured error rather
 * than letting a slow query hang the investigation, and a tool call NEVER
 * throwing — every failure mode becomes a `ToolError` the model can read
 * and reason about, the same way a real tool-use API's `tool_result` can
 * carry `is_error` instead of blowing up the whole conversation.
 */
import type { Logger } from '@sentinel/observability';
export type { Logger };

export interface ToolError {
  readonly error: true;
  readonly code: 'timeout' | 'invalid_argument' | 'internal_error';
  readonly message: string;
}

export type ToolOutcome<T> = T | ToolError;

export function isToolError(value: unknown): value is ToolError {
  return typeof value === 'object' && value !== null && (value as { error?: unknown }).error === true;
}

/** AC3: "an oversized result is truncated with an explicit marker rather
 * than silently cut." `max` is a count of items, not bytes — good enough
 * for every tool here, all of which return a bounded list of rows. */
export function truncate<T>(items: readonly T[], max: number): { items: T[]; truncated: boolean } {
  if (items.length <= max) return { items: [...items], truncated: false };
  return { items: items.slice(0, max), truncated: true };
}

export class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`${toolName} did not complete within ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
  }
}

/**
 * Races `fn` against a timer. `onTimeout`, if given, is invoked when the
 * timer wins (e.g. to call `AbortController.abort()` on an in-flight
 * ClickHouse query) — best-effort cancellation, not a guarantee the
 * underlying call stops; the caller gets its structured timeout error
 * back either way.
 */
export async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, toolName: string, onTimeout?: () => void): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new ToolTimeoutError(toolName, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function toStructuredError(err: unknown): ToolError {
  if (err instanceof ToolTimeoutError) {
    return { error: true, code: 'timeout', message: err.message };
  }
  if (err instanceof ToolInvalidArgumentError) {
    return { error: true, code: 'invalid_argument', message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: true, code: 'internal_error', message };
}

export class ToolInvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInvalidArgumentError';
  }
}

export interface RunToolOptions<T> {
  readonly name: string;
  readonly tenantId: string;
  readonly args: unknown;
  readonly timeoutMs: number;
  readonly logger: Logger;
  readonly fn: (signal: AbortSignal) => Promise<T>;
}

/**
 * The one entry point every tool handler goes through (AC2/AC4/AC5 all
 * live here, not in each tool): times the call out, converts any thrown
 * error into a `ToolError` instead of propagating it, and logs the call
 * with its arguments and result — AC4's "replay and debugging" — exactly
 * once, on both the success and failure path, never silently.
 */
export async function runTool<T>(opts: RunToolOptions<T>): Promise<ToolOutcome<T>> {
  const start = Date.now();
  const controller = new AbortController();
  try {
    const result = await withTimeout(() => opts.fn(controller.signal), opts.timeoutMs, opts.name, () => controller.abort());
    opts.logger.info(
      { tool: opts.name, tenantId: opts.tenantId, args: opts.args, result, durationMs: Date.now() - start },
      'investigation tool call',
    );
    return result;
  } catch (err) {
    const toolError = toStructuredError(err);
    opts.logger.warn(
      { tool: opts.name, tenantId: opts.tenantId, args: opts.args, error: toolError, durationMs: Date.now() - start },
      'investigation tool call failed',
    );
    return toolError;
  }
}
