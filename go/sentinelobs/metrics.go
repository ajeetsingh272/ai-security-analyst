package sentinelobs

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// Metrics holds the golden-signal instruments every instrumented service
// needs (AC4): request rate (RequestCount), errors (ErrorCount) and latency
// distribution (Duration). Deliberately just these three — RED (Rate,
// Errors, Duration) rather than every metric a service COULD emit, because
// "golden signals visible in Grafana" is the acceptance criterion, not
// exhaustive instrumentation.
type Metrics struct {
	RequestCount metric.Int64Counter
	ErrorCount   metric.Int64Counter
	Duration     metric.Float64Histogram
}

// NewMeterProvider mirrors NewTracerProvider for metrics: exports via OTLP
// gRPC to the same otel-collector, which re-exports them in Prometheus
// format on :8889 for Prometheus to scrape (otel-collector-config.yaml).
func NewMeterProvider(ctx context.Context, serviceName, otlpEndpoint string) (*sdkmetric.MeterProvider, *Metrics, func(context.Context) error, error) {
	exporter, err := otlpmetricgrpc.New(ctx,
		otlpmetricgrpc.WithEndpoint(otlpEndpoint),
		otlpmetricgrpc.WithInsecure(),
	)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("sentinelobs: creating OTLP metric exporter: %w", err)
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(semconv.ServiceName(serviceName)),
	)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("sentinelobs: building resource: %w", err)
	}

	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		// 5s rather than the SDK's 60s default — AC4's "visible in a local
		// Grafana" means a developer watching a dashboard right after a
		// synthetic run, not a minute later.
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter, sdkmetric.WithInterval(5*time.Second))),
	)
	otel.SetMeterProvider(mp)

	meter := mp.Meter(serviceName)
	requestCount, err := meter.Int64Counter("http.server.request_count",
		metric.WithDescription("Total HTTP requests received"))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("sentinelobs: creating request_count counter: %w", err)
	}
	errorCount, err := meter.Int64Counter("http.server.error_count",
		metric.WithDescription("Total HTTP requests that resulted in a 5xx response"))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("sentinelobs: creating error_count counter: %w", err)
	}
	duration, err := meter.Float64Histogram("http.server.duration",
		metric.WithDescription("HTTP request duration"),
		metric.WithUnit("ms"))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("sentinelobs: creating duration histogram: %w", err)
	}

	return mp, &Metrics{RequestCount: requestCount, ErrorCount: errorCount, Duration: duration}, mp.Shutdown, nil
}

// InstrumentHandler wraps h so every request through it records the golden
// signals above, keyed by route — a handler registered via
// http.ServeMux.HandleFunc("GET /healthz", ...) already carries its pattern
// on the request after Go 1.22's routing, so `route` is explicit here
// rather than re-derived, since a ServeMux registered under an older-style
// pattern wouldn't have one.
func (m *Metrics) InstrumentHandler(route string, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

		h.ServeHTTP(rec, r)

		attrs := metric.WithAttributes(attribute.String("http.route", route))
		ctx := r.Context()
		m.RequestCount.Add(ctx, 1, attrs)
		if rec.status >= 500 {
			m.ErrorCount.Add(ctx, 1, attrs)
		}
		m.Duration.Record(ctx, float64(time.Since(start).Microseconds())/1000, attrs)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}
