/**
 * P0-10 AC2/AC3: every log line carries tenant_id and trace_id when
 * available, and is redacted — as a property of the logger itself, not
 * something each call site has to remember.
 */
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { trace, context } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { withTenantContext } from '@sentinel/db';
import { createLogger } from '../logger.js';

/** A Writable that just parses each chunk as one JSON log line — pino's
 * `destination` constructor argument is the documented way to redirect its
 * output, so this is what createLogger's own `destination` option targets. */
function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const raw: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      raw.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines: () => raw.map((l) => JSON.parse(l)) };
}

describe('createLogger', () => {
  it('produces structured JSON with the service name attached', () => {
    const { stream, lines } = capture();
    const logger = createLogger({ service: 'tenant-api', destination: stream });
    logger.info({ action: 'probe' }, 'hello');

    const [line] = lines();
    expect(line!.service).toBe('tenant-api');
    expect(line!.action).toBe('probe');
    expect(line!.msg).toBe('hello');
  });

  it('attaches tenant_id when called inside an active tenant context, and omits it outside one', () => {
    const { stream, lines } = capture();
    const logger = createLogger({ service: 'x', destination: stream });

    const tenantId = '11111111-1111-4111-8111-111111111111';
    withTenantContext(tenantId, () => {
      logger.info('inside tenant context');
    });
    logger.info('outside any tenant context');

    const [inside, outside] = lines();
    expect(inside!.tenant_id).toBe(tenantId);
    expect(outside!.tenant_id).toBeUndefined();
  });

  it('attaches trace_id and span_id when called inside an active span, and omits them outside one', () => {
    const provider = new NodeTracerProvider();
    provider.register();
    const tracer = trace.getTracer('test');

    const { stream, lines } = capture();
    const logger = createLogger({ service: 'x', destination: stream });

    const span = tracer.startSpan('probe-span');
    context.with(trace.setSpan(context.active(), span), () => {
      logger.info('inside a span');
    });
    span.end();
    logger.info('outside any span');

    const [inside, outside] = lines();
    expect(inside!.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(inside!.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(outside!.trace_id).toBeUndefined();
  });

  it('redacts a secret passed directly in a logged object (AC3)', () => {
    const { stream, lines } = capture();
    const logger = createLogger({ service: 'x', destination: stream });

    logger.info(
      { apiCall: { headers: { authorization: 'Bearer super-secret-value-here' } } },
      'calling out',
    );

    const [line] = lines();
    expect(JSON.stringify(line)).not.toContain('super-secret-value-here');
  });

  it('redacts a secret embedded directly in the log message string', () => {
    const { stream, lines } = capture();
    const logger = createLogger({ service: 'x', destination: stream });

    logger.info('retrying with api_key=sk_live_abc123XYZSECRET');

    const [line] = lines();
    expect(line!.msg as string).not.toContain('sk_live_abc123XYZSECRET');
  });
});
