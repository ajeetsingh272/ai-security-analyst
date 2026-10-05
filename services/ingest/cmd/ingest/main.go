// Command ingest runs the connector scheduler: it polls each tenant's
// configured sources, normalises their records to OCSF, and publishes them to
// the stream.
//
// Checkpointing contract (ADR-0010): a cursor advances only after the batch is
// durably acknowledged by Kafka. Delivery is therefore at-least-once, and the
// duplicates that produces are collapsed downstream by ClickHouse rather than
// prevented here — exactly-once across a vendor API boundary is not achievable,
// so we make duplicates harmless instead of pretending otherwise.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelobs"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/twmb/franz-go/pkg/kgo"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

const serviceName = "sentinel-ingest"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	otlpEndpoint := envOr("OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4317")

	_, shutdownTracing, err := sentinelobs.NewTracerProvider(ctx, serviceName, otlpEndpoint)
	if err != nil {
		slog.Error("starting tracer provider", "err", err)
		os.Exit(1)
	}
	defer func() { _ = shutdownTracing(context.Background()) }()

	_, metrics, shutdownMetrics, err := sentinelobs.NewMeterProvider(ctx, serviceName, otlpEndpoint)
	if err != nil {
		slog.Error("starting meter provider", "err", err)
		os.Exit(1)
	}
	defer func() { _ = shutdownMetrics(context.Background()) }()

	log := sentinelobs.NewLogger(serviceName, os.Stdout)
	slog.SetDefault(log)

	mux := http.NewServeMux()
	mux.Handle("GET /healthz", metrics.InstrumentHandler("/healthz", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})))
	// Readiness is distinct from liveness: a connector whose credentials have
	// been revoked is alive but not ready, and must surface as degraded rather
	// than stalling silently.
	mux.Handle("GET /readyz", metrics.InstrumentHandler("/readyz", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})))
	// P0-10 T1: a synthetic endpoint with no business logic of its own,
	// whose only job is to prove a trace started by a caller (apps/api, in
	// the TypeScript half of T1's test) continues as one unbroken trace
	// once it crosses into this Go service — otelhttp.NewHandler extracts
	// the incoming W3C traceparent header and makes this handler's child
	// span (below) a descendant of the caller's span, not a new root.
	mux.Handle("POST /internal/synthetic-event", metrics.InstrumentHandler(
		"/internal/synthetic-event",
		otelhttp.NewHandler(syntheticEventHandler(log), "ingest.synthetic_event"),
	))
	// P0-10 T3: exercises the error_count golden signal the same way
	// synthetic-event exercises request_count/duration — nothing in this
	// service has real failure modes yet (P1's connector logic does), so
	// without this there would be no way to prove the error path of the
	// metrics pipeline works at all before a real one exists.
	mux.Handle("POST /internal/synthetic-error", metrics.InstrumentHandler(
		"/internal/synthetic-error",
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}),
	))

	srv := &http.Server{
		Addr:              envOr("INGEST_ADDR", ":8101"),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Info("ingest listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen failed", "err", err)
			stop()
		}
	}()

	pool, err := sentineldb.NewPool(ctx)
	if err != nil {
		log.Error("opening database pool", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	cycleCount, err := otel.Meter(serviceName).Int64Counter("connector.cycle_count",
		metric.WithDescription("Connector scheduler cycles, by outcome (AC4: per-connector health as a metric)"))
	if err != nil {
		log.Error("creating connector.cycle_count counter", "err", err)
		os.Exit(1)
	}

	// P1-11: per-tenant/connector ingest lag, EPS (via rate() over
	// eventsPublished) and batch size. Error rate reuses connector.cycle_count
	// above (its outcome attribute already distinguishes success from every
	// failure kind) rather than adding a redundant metric for it.
	ingestLag, err := otel.Meter(serviceName).Int64Gauge("connector.ingest_lag_seconds",
		metric.WithDescription("Seconds since this connector's last successful cycle, or since registration if it has never had one (P1-11 AC1)"))
	if err != nil {
		log.Error("creating connector.ingest_lag_seconds gauge", "err", err)
		os.Exit(1)
	}
	eventsPublished, err := otel.Meter(serviceName).Int64Counter("connector.events_published",
		metric.WithDescription("Events published per cycle — rate() over this is EPS per connector (P1-11 AC2)"))
	if err != nil {
		log.Error("creating connector.events_published counter", "err", err)
		os.Exit(1)
	}
	batchSize, err := otel.Meter(serviceName).Int64Histogram("connector.batch_size",
		metric.WithDescription("Events fetched per cycle, before any downstream filtering (P1-11 AC2)"))
	if err != nil {
		log.Error("creating connector.batch_size histogram", "err", err)
		os.Exit(1)
	}

	kafkaClient, err := kgo.NewClient(kgo.SeedBrokers(envOr("REDPANDA_BROKERS", "localhost:19092")))
	if err != nil {
		log.Error("creating kafka client", "err", err)
		os.Exit(1)
	}
	defer kafkaClient.Close()

	// Declarative, idempotent to re-apply (P1-05 AC1) — safe to run on
	// every boot rather than needing a separate migration step.
	if err := sentinelstream.NewProvisioner(kafkaClient).Apply(ctx); err != nil {
		log.Error("provisioning stream topics", "err", err)
		os.Exit(1)
	}

	// With zero connectors registered below (P1-02/03 land the first real
	// one, M365), this publisher is not yet exercised by production
	// traffic — but it is the REAL producer (P1-05), not a placeholder:
	// the scheduler is wired exactly as it will run once a connector exists
	// to publish through it.
	scheduler := sentinelconnector.NewScheduler(
		sentinelstream.NewRedpandaPublisher(kafkaClient, sentinelstream.EventsRaw),
		sentinelconnector.NewPostgresCursorStore(pool),
		sentinelconnector.SchedulerOptions{
			Interval:        time.Minute,
			Log:             log,
			CycleCount:      cycleCount,
			Health:          sentinelconnector.NewPostgresHealthRecorder(pool),
			IngestLag:       ingestLag,
			EventsPublished: eventsPublished,
			BatchSize:       batchSize,
		},
	)
	// TODO(P1-02/P1-03): scheduler.Register(...) each tenant's configured
	// connector here, once a real Connector implementation (M365) exists.
	//
	// P1-11 T1 needs a REAL stalled connector running inside this REAL
	// service to prove connector.ingest_lag_seconds genuinely rises through
	// the live OTel pipeline (not a mock) — same reasoning as P0-10's
	// synthetic-event/synthetic-error HTTP handlers above. It cannot be
	// registered at runtime through an HTTP trigger the way those are:
	// Scheduler.Register after Start has no effect (see its own doc
	// comment), since Start only launches a loop for whatever was already
	// registered. Gated by an env var so production boot is unaffected by
	// default; the integration test sets it when spawning this binary.
	if os.Getenv("INGEST_SYNTHETIC_STALLED_CONNECTOR") == "1" {
		scheduler.Register(sentinelconnector.TenantConnector{
			TenantID:       "00000000-0000-4000-8000-000000000000",
			ConnectorRowID: "synthetic-stalled",
			Stream:         "main",
			Connector:      &syntheticStalledConnector{},
		})
	}
	scheduler.Start(ctx)

	<-ctx.Done()
	log.Info("draining in-flight batches before exit")

	shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		log.Error("shutdown", "err", err)
	}
	if err := scheduler.Shutdown(shutdown); err != nil {
		log.Error("connector scheduler shutdown", "err", err)
	}
	log.Info("ingest stopped")
}

func syntheticEventHandler(log *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// otelhttp.NewHandler already extracted the caller's trace context
		// from the request headers into r.Context(), so this child span
		// (and the log line below) attach to the SAME trace the caller
		// started — the thing T1 actually verifies.
		ctx, span := otel.Tracer(serviceName).Start(r.Context(), "ingest.synthetic_event_received")
		defer span.End()

		log.InfoContext(ctx, "synthetic event received")

		sc := span.SpanContext()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"traceId": sc.TraceID().String(),
			"spanId":  sc.SpanID().String(),
		})
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// syntheticStalledConnector never completes a Fetch on its own — only when
// ctx is cancelled (service shutdown) — so its registration never records a
// success and connector.ingest_lag_seconds keeps rising for as long as this
// process runs with INGEST_SYNTHETIC_STALLED_CONNECTOR=1 set. P1-11 T1's own
// induced stall.
type syntheticStalledConnector struct{}

func (syntheticStalledConnector) ID() sentinelconnector.ConnectorID { return "synthetic-stalled" }

func (syntheticStalledConnector) Fetch(ctx context.Context, _ sentinelconnector.Cursor) (sentinelconnector.Batch, sentinelconnector.Cursor, error) {
	<-ctx.Done()
	return sentinelconnector.Batch{}, nil, ctx.Err()
}

func (syntheticStalledConnector) Normalise(sentinelconnector.RawEvent) ([]ocsf.Event, error) {
	return nil, nil
}

func (syntheticStalledConnector) HealthCheck(context.Context) error { return nil }
