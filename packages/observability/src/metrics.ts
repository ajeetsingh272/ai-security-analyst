/**
 * Golden-signal metrics (P0-10 AC4) — rate, errors, duration. Exported via
 * OTLP gRPC to the same otel-collector traces go to; the collector's own
 * config is what turns these into Prometheus-scrapable series (AC4 "visible
 * in a local Grafana"), not anything in this file.
 */
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { Counter, Histogram } from '@opentelemetry/api';

export interface GoldenSignalMetrics {
  requestCount: Counter;
  errorCount: Counter;
  duration: Histogram;
}

export interface StartMetricsOptions {
  serviceName: string;
  otlpEndpoint?: string;
}

export interface MetricsHandle {
  metrics: GoldenSignalMetrics;
  shutdown: () => Promise<void>;
}

export function startMetrics({
  serviceName,
  otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'localhost:4317',
}: StartMetricsOptions): MetricsHandle {
  const provider = new MeterProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    readers: [
      new PeriodicExportingMetricReader({
        // 5s rather than the SDK's 60s default, same reasoning as the Go
        // side — a developer running a synthetic request wants to see it
        // in Grafana right away, not a minute later.
        exportIntervalMillis: 5000,
        exporter: new OTLPMetricExporter({ url: `http://${otlpEndpoint}` }),
      }),
    ],
  });

  const meter = provider.getMeter(serviceName);
  const metrics: GoldenSignalMetrics = {
    requestCount: meter.createCounter('http.server.request_count', {
      description: 'Total HTTP requests received',
    }),
    errorCount: meter.createCounter('http.server.error_count', {
      description: 'Total HTTP requests that resulted in a 5xx response',
    }),
    duration: meter.createHistogram('http.server.duration', {
      description: 'HTTP request duration',
      unit: 'ms',
    }),
  };

  return { metrics, shutdown: () => provider.shutdown() };
}
