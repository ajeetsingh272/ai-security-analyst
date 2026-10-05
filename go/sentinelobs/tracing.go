package sentinelobs

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// NewTracerProvider wires a service up to send traces to the otel-collector
// (infra/docker/otel-collector-config.yaml is the one place that decides
// traces go to Jaeger from there — this package never points at Jaeger
// directly, matching how the TypeScript side is wired). Call the returned
// shutdown func on exit so buffered spans are flushed rather than dropped.
//
// serviceName becomes Jaeger's service filter (e.g. "sentinel-ingest") —
// this is what T1's cross-language trace test looks for to confirm a trace
// really did span both a Go and a TypeScript service, not just one calling
// itself twice.
func NewTracerProvider(ctx context.Context, serviceName, otlpEndpoint string) (*sdktrace.TracerProvider, func(context.Context) error, error) {
	exporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(otlpEndpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("sentinelobs: creating OTLP trace exporter: %w", err)
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(semconv.ServiceName(serviceName)),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("sentinelobs: building resource: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	// W3C traceparent is what lets a trace cross the Go/TypeScript boundary
	// on the wire (ADR-independent — it's a public standard, not something
	// this repo invented), so the global propagator must be set regardless
	// of which service starts it.
	otel.SetTextMapPropagator(propagation.TraceContext{})

	return tp, tp.Shutdown, nil
}
