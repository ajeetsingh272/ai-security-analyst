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
	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelobs"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/redis/go-redis/v9"
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

	quotaBreaches, err := otel.Meter(serviceName).Int64Counter("connector.quota_breach_count",
		metric.WithDescription("Cycles where a tenant's requested volume exceeded its rate limit (P1-10 AC4)"))
	if err != nil {
		log.Error("creating connector.quota_breach_count counter", "err", err)
		os.Exit(1)
	}

	// P1-10: a real, shared Redis-backed token bucket (AC1/AC2), wrapped so
	// Redis being unreachable degrades to a conservative in-process limit
	// rather than halting ingest (AC5) — ratelimit.go's own doc comments
	// explain why FailOpenLimiter's fallback is deliberately the smallest
	// tier's quota, not the tenant's real one.
	redisClient := redis.NewClient(&redis.Options{Addr: envOr("REDIS_ADDR", "localhost:6379")})
	rateLimiter := sentinelconnector.NewFailOpenLimiter(
		sentinelconnector.NewRedisTokenBucket(redisClient),
		func(tenantID string, err error) {
			log.Warn("rate limiter failed open to the conservative fallback quota", "tenant_id", tenantID, "err", err)
		},
	)

	s3Client := s3.New(s3.Options{
		Region:       envOr("S3_REGION", "ap-south-1"),
		Credentials:  credentials.NewStaticCredentialsProvider(envOr("S3_ACCESS_KEY", "sentineldev"), envOr("S3_SECRET_KEY", "sentineldev"), ""),
		BaseEndpoint: aws.String(envOr("S3_ENDPOINT", "http://localhost:8333")),
		UsePathStyle: true,
	})
	archiveWriter := sentinelconnector.NewS3ArchiveWriter(s3Client, envOr("S3_ARCHIVE_BUCKET", "sentinel-archive"))

	// No real Publisher exists yet — P1-05 is what wires a real Redpanda
	// producer in. InMemoryPublisher is an explicit, visible placeholder,
	// not a silent stand-in: with zero connectors registered below (P1-02/03
	// land the first real one, M365), it is never actually exercised by
	// production traffic. What this proves today is that the scheduler
	// itself starts, runs, and shuts down cleanly as part of this real
	// service — the framework, ahead of anything to run through it.
	scheduler := sentinelconnector.NewScheduler(
		sentinelconnector.NewInMemoryPublisher(),
		sentinelconnector.NewPostgresCursorStore(pool),
		sentinelconnector.SchedulerOptions{
			Interval:      time.Minute,
			Log:           log,
			CycleCount:    cycleCount,
			Health:        sentinelconnector.NewPostgresHealthRecorder(pool),
			RateLimiter:   rateLimiter,
			Archive:       archiveWriter,
			QuotaBreaches: quotaBreaches,
		},
	)
	// TODO(P1-02/P1-03): scheduler.Register(...) each tenant's configured
	// connector here, once a real Connector implementation (M365) exists —
	// looking up that tenant's tenants.plan column to resolve its Quota
	// (sentinelconnector.DefaultQuotas[plan]) at registration time, per
	// quota.go's own doc comment.
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
