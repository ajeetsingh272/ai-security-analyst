// Command detect evaluates normalised events against the compiled rule corpus.
//
// Rules are compiled to Go at build time (ADR-0004) rather than interpreted
// from YAML at runtime, which is roughly an order of magnitude cheaper per
// event — the difference between a three-node and a thirty-node detection tier
// at 30k EPS.
//
// Rules marked critical publish to the alert channel directly, in parallel with
// entering correlation. That bypass is what keeps the customer warned when the
// AI analyst is unavailable (product guarantee TG4).
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelenrich"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelobs"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/detectgen"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/dispatch"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/hotfix"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/suppression"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/windowed"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/worker"
	"github.com/twmb/franz-go/pkg/kgo"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

const serviceName = "sentinel-detect"

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

	rulesDir, err := corpusDir()
	if err != nil {
		log.Error("locating detections/rules", "err", err)
		os.Exit(1)
	}
	rules, errs := sigmac.ParseCorpus(rulesDir)
	if len(errs) != 0 {
		log.Error("parsing rule corpus", "errs", errs)
		os.Exit(1)
	}

	candidateCount, err := otel.Meter(serviceName).Int64Histogram("detect.candidate_count",
		metric.WithDescription("Candidate rule count surviving dispatch narrowing, per event"))
	if err != nil {
		log.Error("creating detect.candidate_count histogram", "err", err)
		os.Exit(1)
	}
	tree, err := dispatch.Build(rules, detectgen.Rules, dispatch.Options{CandidateCount: candidateCount})
	if err != nil {
		log.Error("building dispatch tree", "err", err)
		os.Exit(1)
	}

	group := envOr("CONSUMER_GROUP", "detect")
	consumerClient, err := kgo.NewClient(
		kgo.SeedBrokers(envOr("REDPANDA_BROKERS", "localhost:19092")),
		kgo.ConsumeTopics(sentinelstream.EventsNormalized),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		// Offsets commit only after every record in a poll has been
		// published as a signal or routed to DLQ (AC2) — the same
		// false-ack-ordering concern ADR-0010 raises for the producer
		// side, applied here to this worker's own consumption.
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		log.Error("creating kafka consumer client", "err", err)
		os.Exit(1)
	}
	defer consumerClient.Close()

	// A dedicated, ungrouped client for everything this worker PUBLISHES
	// (signals and signals.dlq) — producing and a joined consumer group
	// are two different concerns, the same split services/eventwriter's
	// own DLQ client already uses.
	producerClient, err := kgo.NewClient(kgo.SeedBrokers(envOr("REDPANDA_BROKERS", "localhost:19092")))
	if err != nil {
		log.Error("creating kafka producer client", "err", err)
		os.Exit(1)
	}
	defer producerClient.Close()

	signalsEmitted, err := otel.Meter(serviceName).Int64Counter("detect.signals_emitted",
		metric.WithDescription("Signals published to the signals topic"))
	if err != nil {
		log.Error("creating detect.signals_emitted counter", "err", err)
		os.Exit(1)
	}
	evalErrors, err := otel.Meter(serviceName).Int64Counter("detect.eval_errors",
		metric.WithDescription("Rule evaluations that panicked or otherwise failed and were routed to signals.dlq"))
	if err != nil {
		log.Error("creating detect.eval_errors counter", "err", err)
		os.Exit(1)
	}
	partitionLag, err := otel.Meter(serviceName).Int64Gauge("detect.consumer_lag",
		metric.WithDescription("events.normalized consumer lag, per partition"))
	if err != nil {
		log.Error("creating detect.consumer_lag gauge", "err", err)
		os.Exit(1)
	}
	criticalAlertsEmitted, err := otel.Meter(serviceName).Int64Counter("detect.critical_alerts_emitted",
		metric.WithDescription("Critical signals published directly to alerts.critical (P2-08/TG4 bypass), independent of the normal signals path"))
	if err != nil {
		log.Error("creating detect.critical_alerts_emitted counter", "err", err)
		os.Exit(1)
	}

	// P2-09: threat-intel enrichment. Lookup is called synchronously
	// from the worker's own per-event path, but every byte it reads
	// comes from the Store this Refresher already loaded in the
	// background — AC1's "detection never makes a synchronous external
	// call" is true because Fetch only ever runs on enrichRefresher's
	// own ticker (Run, below), never on the worker's.
	enrichRefreshErrors, err := otel.Meter(serviceName).Int64Counter("detect.enrichment_refresh_errors",
		metric.WithDescription("A threat-intel feed refresh attempt failed; the previously loaded data is still being served"))
	if err != nil {
		log.Error("creating detect.enrichment_refresh_errors counter", "err", err)
		os.Exit(1)
	}
	enrichStale, err := otel.Meter(serviceName).Int64Gauge("detect.enrichment_stale",
		metric.WithDescription("1 if the threat-intel feeds have not refreshed successfully within the staleness threshold (AC4), else 0"))
	if err != nil {
		log.Error("creating detect.enrichment_stale gauge", "err", err)
		os.Exit(1)
	}
	enrichRefresher := sentinelenrich.New(sentinelenrich.Options{
		CacheDir: envOr("ENRICHMENT_CACHE_DIR", filepath.Join(os.TempDir(), "sentinel-enrichment")),
		Log:      log,
		Metrics: sentinelenrich.Metrics{
			RefreshErrors: enrichRefreshErrors,
			Stale:         enrichStale,
		},
	})
	if err := enrichRefresher.LoadFromCache(); err != nil {
		log.Info("no cached threat-intel feeds yet; will be empty until the first refresh completes", "err", err)
	}
	go enrichRefresher.Run(ctx)

	// P2-10/TG3: suppression. pgPool is used only through
	// suppression.Checker's own tenant-scoped reads (sentineldb.
	// WithTenantContext) — this binary writes nothing to Postgres itself;
	// creating/revoking/renewing a suppression is apps/api's job.
	pgPool, err := sentineldb.NewPool(ctx)
	if err != nil {
		log.Error("connecting to postgres for suppression checks", "err", err)
		os.Exit(1)
	}
	defer pgPool.Close()
	suppressionChecker := suppression.NewPostgresChecker(pgPool)

	// P2-12/ADR-0004: the emergency hotfix rule path. Reuses pgPool
	// above — this is a second, independent read against the same
	// cluster, not a second connection concern. hotfixLoader.Run starts
	// its own background refresh ticker; Active() is read lock-free
	// from the worker's own hot path.
	hotfixLoader := hotfix.NewLoader(hotfix.NewPostgresSource(pgPool), log)
	go hotfixLoader.Run(ctx, 30*time.Second)

	w := worker.New(tree, consumerClient, producerClient, worker.Options{
		Group:              group,
		Log:                log,
		Enricher:           enrichRefresher,
		SuppressionChecker: suppressionChecker,
		HotfixRules:        hotfixLoader,
		Metrics: worker.Metrics{
			SignalsEmitted:        signalsEmitted,
			EvalErrors:            evalErrors,
			PartitionLag:          partitionLag,
			CriticalAlertsEmitted: criticalAlertsEmitted,
		},
	})

	go w.RunLagReporter(ctx, sentinelstream.EventsNormalized, 10*time.Second)

	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		if err := w.Run(ctx); err != nil && ctx.Err() == nil {
			log.Error("worker stopped unexpectedly", "err", err)
			stop()
		}
	}()

	chConn, err := clickhouse.Open(&clickhouse.Options{
		Addr: []string{envOr("CLICKHOUSE_ADDR", "localhost:9000")},
		Auth: clickhouse.Auth{
			Database: envOr("CLICKHOUSE_DATABASE", "sentinel"),
			Username: envOr("CLICKHOUSE_USER", "default"),
			Password: envOr("CLICKHOUSE_PASSWORD", ""),
		},
	})
	if err != nil {
		log.Error("connecting to ClickHouse for windowed rules", "err", err)
		os.Exit(1)
	}
	defer chConn.Close()

	windowedSignalsEmitted, err := otel.Meter(serviceName).Int64Counter("detect.windowed_signals_emitted",
		metric.WithDescription("Signals published by a windowed (ClickHouse-scheduled) rule"))
	if err != nil {
		log.Error("creating detect.windowed_signals_emitted counter", "err", err)
		os.Exit(1)
	}
	windowedQueryErrors, err := otel.Meter(serviceName).Int64Counter("detect.windowed_query_errors",
		metric.WithDescription("A windowed rule's query failed for a reason other than exceeding its budget"))
	if err != nil {
		log.Error("creating detect.windowed_query_errors counter", "err", err)
		os.Exit(1)
	}
	windowedQueryKilled, err := otel.Meter(serviceName).Int64Counter("detect.windowed_query_killed",
		metric.WithDescription("A windowed rule's query exceeded its time budget and was killed (AC4)"))
	if err != nil {
		log.Error("creating detect.windowed_query_killed counter", "err", err)
		os.Exit(1)
	}

	windowedCriticalAlertsEmitted, err := otel.Meter(serviceName).Int64Counter("detect.windowed_critical_alerts_emitted",
		metric.WithDescription("Critical signals published directly to alerts.critical by a windowed rule (P2-08/TG4 bypass)"))
	if err != nil {
		log.Error("creating detect.windowed_critical_alerts_emitted counter", "err", err)
		os.Exit(1)
	}

	windowedScheduler, err := windowed.New(rules, chConn, producerClient, windowed.Options{
		Log:                log,
		SuppressionChecker: suppressionChecker,
		Metrics: windowed.Metrics{
			SignalsEmitted:        windowedSignalsEmitted,
			QueryErrors:           windowedQueryErrors,
			QueryKilled:           windowedQueryKilled,
			CriticalAlertsEmitted: windowedCriticalAlertsEmitted,
		},
	})
	if err != nil {
		log.Error("compiling windowed rules", "err", err)
		os.Exit(1)
	}
	windowedDone := make(chan struct{})
	go func() {
		defer close(windowedDone)
		windowedScheduler.Run(ctx)
	}()

	mux := http.NewServeMux()
	mux.Handle("GET /healthz", metrics.InstrumentHandler("/healthz", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})))
	mux.Handle("GET /readyz", metrics.InstrumentHandler("/readyz", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})))

	srv := &http.Server{
		Addr:              envOr("DETECT_ADDR", ":8104"),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Info("detect listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen failed", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("draining in-flight evaluation before exit")

	shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		log.Error("http shutdown", "err", err)
	}
	select {
	case <-workerDone:
	case <-shutdown.Done():
		log.Error("worker did not stop within the shutdown deadline")
	}
	select {
	case <-windowedDone:
	case <-shutdown.Done():
		log.Error("windowed scheduler did not stop within the shutdown deadline")
	}
	log.Info("detect stopped")
}

// corpusDir walks up from the working directory to the first ancestor
// containing go.work and returns its detections/rules — this binary is
// run both via `go run ./cmd/detect` from services/detect and, in CI,
// from the repo root, so it cannot assume either (the same resolution
// cmd/sigmac-gen's own repoRoot already uses).
func corpusDir() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return filepath.Join(dir, "detections", "rules"), nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", os.ErrNotExist
		}
		dir = parent
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
