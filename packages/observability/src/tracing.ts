/**
 * NodeSDK bootstrap (P0-10 AC1) — every service exports OTLP traces to the
 * otel-collector (never to Jaeger directly; see
 * infra/docker/otel-collector-config.yaml), the same single ingestion point
 * the Go side points at in go/sentinelobs/tracing.go. HTTP and undici
 * instrumentation are what makes a trace cross the Go/TypeScript boundary
 * without any call site manually copying a traceparent header — they patch
 * Node's request machinery to inject/extract it automatically.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface StartTracingOptions {
  serviceName: string;
  /** host:port, no scheme — matches otlptracegrpc.WithEndpoint on the Go
   * side. Defaults to the otel-collector's published dev port. */
  otlpEndpoint?: string;
}

export interface TracingHandle {
  shutdown: () => Promise<void>;
}

export function startTracing({
  serviceName,
  otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'localhost:4317',
}: StartTracingOptions): TracingHandle {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `http://${otlpEndpoint}` }),
    instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
  });
  sdk.start();

  return { shutdown: () => sdk.shutdown() };
}
