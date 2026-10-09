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
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/google"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/m365"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/syslog"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelobs"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
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
	// P1-08: every fetched event, archived before normalisation ever runs
	// — same S3 client and bucket as the overflow archive above, a
	// different key prefix (raw/ vs overflow/) and different failure
	// semantics (a raw-archive failure fails the whole cycle; see
	// RawArchiveWriter's own doc comment for why the two are not one type).
	rawArchiveWriter := sentinelconnector.NewS3RawArchiveWriter(s3Client, envOr("S3_ARCHIVE_BUCKET", "sentinel-archive"))

	// P1-04 fix: the scheduler's Publisher.Publish (publisher.go) is handed
	// already-NORMALISED events (Connector.Normalise's output, marshalled
	// by the scheduler itself) — never raw, pre-normalisation bytes. This
	// was wired to EventsRaw ("events.raw") from P1-01 through P1-03, which
	// went unnoticed because nothing published any real content through it
	// until this ticket (P1-04) gave M365's connector a real mapping to
	// produce. services/eventwriter/cmd/eventwriter/main.go has always
	// consumed "events.normalized" — go/sentinelevents/batch.go's own doc
	// comment says as much ("Nothing publishes to that topic yet — P1-04...
	// is what will"). Without this fix, T5 (event_id survives ingest to
	// ClickHouse) would be unprovable for real, because nothing the
	// scheduler ever produces would reach the ClickHouse writer at all.
	scheduler := sentinelconnector.NewScheduler(
		sentinelstream.NewRedpandaPublisher(kafkaClient, sentinelstream.EventsNormalized),
		sentinelconnector.NewPostgresCursorStore(pool),
		sentinelconnector.SchedulerOptions{
			Interval:        time.Minute,
			Log:             log,
			CycleCount:      cycleCount,
			Health:          sentinelconnector.NewPostgresHealthRecorder(pool),
			RateLimiter:     rateLimiter,
			Archive:         archiveWriter,
			QuotaBreaches:   quotaBreaches,
			RawArchive:      rawArchiveWriter,
			IngestLag:       ingestLag,
			EventsPublished: eventsPublished,
			BatchSize:       batchSize,
		},
	)
	// P1-03: register one M365 connector per (tenant, content type) that
	// has an active connectors row. This is a genuinely cross-tenant read
	// at boot — exactly the "privileged role for a background job that
	// legitimately spans tenants" exception ADR-0008's own risk table
	// names, not a bypass of it: `pool` here is the same superuser-
	// authenticated pool sentineldb.NewPool always returns (RLS is
	// enforced per-tenant only once sentineldb.WithTenantContext switches
	// role — see registerM365Connectors for where that happens for every
	// subsequent query against this tenant's own rows).
	if err := registerM365Connectors(ctx, pool, kafkaClient, scheduler, log); err != nil {
		log.Error("registering m365 connectors", "err", err)
	}

	// P7-01: the second identity-platform connector, proving
	// registerM365Connectors' own shape generalises to a different vendor
	// without any change to this file's surrounding structure.
	if err := registerGoogleConnectors(ctx, pool, kafkaClient, scheduler, log); err != nil {
		log.Error("registering google_workspace connectors", "err", err)
	}

	// P1-13: the dry run's own registration — proving a second connector
	// (go/sentinelconnector/syslog) needs nothing from THIS file beyond
	// exactly this shape: a listener to start, and one scheduler.Register
	// call. No change to sentinelconnector, sentinelstream, sentineldb,
	// detect or correlate was needed to add it — see
	// docs/architecture/connector-developer-guide.md. Gated by an env var,
	// same pattern as M365 (unset client id) and the synthetic stalled
	// connector below: production boot is unaffected by default.
	if addr := os.Getenv("SYSLOG_LISTEN_ADDR"); addr != "" {
		if err := registerSyslogConnector(ctx, addr, pool, scheduler, log); err != nil {
			log.Error("registering syslog connector", "err", err)
		}
	}

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

// registerSyslogConnector starts one shared TCP listener and registers it
// against every tenant with an active syslog connectors row — the exact
// same cross-tenant discovery shape registerM365Connectors already uses,
// deliberately: P1-13's whole point is that a second connector looks like
// this from the framework's point of view, not like something bespoke.
func registerSyslogConnector(ctx context.Context, addr string, pool *pgxpool.Pool, scheduler *sentinelconnector.Scheduler, log *slog.Logger) error {
	listener, err := syslog.NewListener(addr, log)
	if err != nil {
		return fmt.Errorf("binding syslog listener on %s: %w", addr, err)
	}
	go listener.Serve(ctx)
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()

	rows, err := pool.Query(ctx, `SELECT id, tenant_id FROM connectors WHERE kind = 'syslog' AND status != 'revoked'`)
	if err != nil {
		return fmt.Errorf("listing syslog connectors: %w", err)
	}
	defer rows.Close()

	registered := 0
	for rows.Next() {
		var connectorRowID, tenantID string
		if err := rows.Scan(&connectorRowID, &tenantID); err != nil {
			return fmt.Errorf("scanning syslog connector row: %w", err)
		}
		scheduler.Register(sentinelconnector.TenantConnector{
			TenantID:       tenantID,
			ConnectorRowID: connectorRowID,
			Stream:         "main",
			Connector:      syslog.NewConnector(tenantID, listener),
		})
		registered++
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterating syslog connector rows: %w", err)
	}
	log.Info("registered syslog connectors", "registrations", registered, "listen_addr", listener.Addr())
	return nil
}

// registerM365Connectors discovers every tenant with an active ('healthy',
// 'degraded' or 'pending' — anything but 'revoked') m365 connectors row and
// registers one TenantConnector per (tenant, content type), mirroring
// m365.ContentTypes exactly (AC1: Audit.Exchange/SharePoint/
// AzureActiveDirectory/General). Returns nil (not an error that stops this
// service booting) when M365_CLIENT_ID/CLIENT_SECRET or
// KMS_LOCAL_MASTER_KEY aren't set — there being no Entra app registration
// yet is the expected, normal state for every environment that hasn't
// completed P1-02's consent flow, the same graceful-absence framing
// apps/api's own m365OAuthConfigFromEnv uses.
func registerM365Connectors(ctx context.Context, pool *pgxpool.Pool, kafkaClient *kgo.Client, scheduler *sentinelconnector.Scheduler, log *slog.Logger) error {
	clientID := os.Getenv("M365_CLIENT_ID")
	clientSecret := os.Getenv("M365_CLIENT_SECRET")
	if clientID == "" || clientSecret == "" {
		log.Info("m365 connector not configured (M365_CLIENT_ID/M365_CLIENT_SECRET unset) — skipping registration")
		return nil
	}

	store, err := m365.NewCredentialStore(pool)
	if err != nil {
		log.Info("m365 credential store unavailable, skipping registration", "err", err)
		return nil
	}

	oauthCfg := m365.OAuthConfig{
		ClientID:         clientID,
		ClientSecret:     clientSecret,
		AuthorityBaseURL: os.Getenv("M365_AUTHORITY_BASE_URL"),
	}
	managementAPIBaseURL := os.Getenv("M365_MANAGEMENT_API_BASE_URL")
	dlq := sentinelstream.NewRedpandaPublisher(kafkaClient, sentinelstream.EventsRawDLQ)

	rows, err := pool.Query(ctx, `SELECT id, tenant_id FROM connectors WHERE kind = 'm365' AND status != 'revoked'`)
	if err != nil {
		return fmt.Errorf("listing m365 connectors: %w", err)
	}
	defer rows.Close()

	registered := 0
	for rows.Next() {
		var connectorRowID, tenantID string
		if err := rows.Scan(&connectorRowID, &tenantID); err != nil {
			return fmt.Errorf("scanning m365 connector row: %w", err)
		}
		for _, contentType := range m365.ContentTypes {
			scheduler.Register(sentinelconnector.TenantConnector{
				TenantID:       tenantID,
				ConnectorRowID: connectorRowID,
				Stream:         contentType,
				Connector:      m365.NewConnector(tenantID, contentType, store, oauthCfg, managementAPIBaseURL, http.DefaultClient, dlq),
			})
			registered++
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterating m365 connector rows: %w", err)
	}
	log.Info("registered m365 connectors", "registrations", registered)
	return nil
}

// registerGoogleConnectors is registerM365Connectors' own shape, ported to
// the second identity-platform vendor (P7-01) — discovers every tenant with
// an active google_workspace connectors row and registers one
// TenantConnector per (tenant, applicationName), mirroring
// google.ApplicationNames (login/admin/drive/token/gmail — AC2). Returns
// nil, not an error that stops this service booting, when
// GOOGLE_CLIENT_ID/CLIENT_SECRET aren't set — there being no real Google
// Cloud OAuth client configured yet is the expected, normal state for
// every environment that hasn't completed the (TS-side, disclosed-as-
// unavailable-in-this-sandbox) consent flow, the same graceful-absence
// framing registerM365Connectors already establishes.
func registerGoogleConnectors(ctx context.Context, pool *pgxpool.Pool, kafkaClient *kgo.Client, scheduler *sentinelconnector.Scheduler, log *slog.Logger) error {
	clientID := os.Getenv("GOOGLE_CLIENT_ID")
	clientSecret := os.Getenv("GOOGLE_CLIENT_SECRET")
	if clientID == "" || clientSecret == "" {
		log.Info("google_workspace connector not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET unset) — skipping registration")
		return nil
	}

	store, err := google.NewCredentialStore(pool)
	if err != nil {
		log.Info("google_workspace credential store unavailable, skipping registration", "err", err)
		return nil
	}

	oauthCfg := google.OAuthConfig{
		ClientID:             clientID,
		ClientSecret:         clientSecret,
		TokenEndpointBaseURL: os.Getenv("GOOGLE_TOKEN_ENDPOINT_BASE_URL"),
	}
	reportsAPIBaseURL := os.Getenv("GOOGLE_REPORTS_API_BASE_URL")
	dlq := sentinelstream.NewRedpandaPublisher(kafkaClient, sentinelstream.EventsRawDLQ)

	rows, err := pool.Query(ctx, `SELECT id, tenant_id FROM connectors WHERE kind = 'google_workspace' AND status != 'revoked'`)
	if err != nil {
		return fmt.Errorf("listing google_workspace connectors: %w", err)
	}
	defer rows.Close()

	registered := 0
	for rows.Next() {
		var connectorRowID, tenantID string
		if err := rows.Scan(&connectorRowID, &tenantID); err != nil {
			return fmt.Errorf("scanning google_workspace connector row: %w", err)
		}
		for _, applicationName := range google.ApplicationNames {
			scheduler.Register(sentinelconnector.TenantConnector{
				TenantID:       tenantID,
				ConnectorRowID: connectorRowID,
				Stream:         applicationName,
				Connector:      google.NewConnector(tenantID, applicationName, store, oauthCfg, reportsAPIBaseURL, http.DefaultClient, dlq),
			})
			registered++
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterating google_workspace connector rows: %w", err)
	}
	log.Info("registered google_workspace connectors", "registrations", registered)
	return nil
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
