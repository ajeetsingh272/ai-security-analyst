// Command correlate clusters signals into cases.
//
// This is the component that makes the product commercially viable, and it
// contains no AI. Signals sharing an entity within a sliding window become one
// case, deterministically. The resulting signal-to-case reduction ratio is a
// monitored SLO (target >= 10:1) rather than an aspiration: if it degrades, the
// unit economics break before the architecture does.
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

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelsignal"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/ajeetsingh272/ai-security-analyst/services/correlate/internal/cluster"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	srv := &http.Server{
		Addr:              envOr("CORRELATE_ADDR", ":8103"),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Info("correlate listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen failed", "err", err)
			stop()
		}
	}()

	pgPool, err := sentineldb.NewPool(ctx)
	if err != nil {
		log.Error("connecting to postgres", "err", err)
		os.Exit(1)
	}
	defer pgPool.Close()

	// P3-02: deliberately uses Signal.EntityType/EntityID directly as the
	// clustering key, NOT routed through P3-01's entity.Resolver here.
	// AC2's own wording is "signals sharing ANY entity" — the raw
	// identifier services/detect's worker/windowed already extract and
	// place on the signal, which is already consistent across rules for
	// the same person today (every path uses the same UserId-shaped
	// value). Feeding the alias GRAPH (collapsing a UPN and an object id
	// for the same person) would need multiple co-occurring raw
	// identifiers from ONE underlying event, which a Signal's own wire
	// shape does not carry — that is a real, separate integration this
	// ticket's own ACs do not require and should not invent a half
	// -working version of.
	clusterer := cluster.NewClusterer(cluster.NewPostgresStore(pgPool), cluster.DefaultWindow)

	group := envOr("CONSUMER_GROUP", "correlate")
	consumer, err := kgo.NewClient(
		kgo.SeedBrokers(envOr("REDPANDA_BROKERS", "localhost:19092")),
		kgo.ConsumeTopics(sentinelstream.Signals),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		// Offsets commit only after every signal in a poll has been
		// clustered (ADR-0010's own checkpoint-after-ack discipline,
		// applied here to this consumer's own reads).
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		log.Error("creating kafka consumer", "err", err)
		os.Exit(1)
	}
	defer consumer.Close()

	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		runClusterLoop(ctx, log, consumer, clusterer)
	}()

	// AC4: "a case closes its window after a configurable quiet period."
	// Swept on its own ticker, independent of whether any signal is
	// currently arriving — a tenant that goes quiet must still have its
	// open cases close eventually, not wait for the next unrelated
	// signal to trigger it.
	quietPeriod := envOr("CASE_QUIET_PERIOD", "2h")
	quietPeriodDuration, err := time.ParseDuration(quietPeriod)
	if err != nil {
		log.Error("parsing CASE_QUIET_PERIOD", "value", quietPeriod, "err", err)
		os.Exit(1)
	}
	sweepDone := make(chan struct{})
	go func() {
		defer close(sweepDone)
		runQuietPeriodSweep(ctx, log, pgPool, clusterer, quietPeriodDuration)
	}()

	<-ctx.Done()
	log.Info("draining in-flight clustering before exit")

	shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		log.Error("http shutdown", "err", err)
	}
	select {
	case <-workerDone:
	case <-shutdown.Done():
		log.Error("cluster loop did not stop within the shutdown deadline")
	}
	select {
	case <-sweepDone:
	case <-shutdown.Done():
		log.Error("quiet-period sweep did not stop within the shutdown deadline")
	}
	log.Info("correlate stopped")
}

// runClusterLoop polls `signals` until ctx is cancelled, committing
// offsets only after every record in a poll has been clustered —
// mirroring services/detect/internal/worker.Worker.Run's own shape for
// the identical reason (ADR-0010).
func runClusterLoop(ctx context.Context, log *slog.Logger, consumer *kgo.Client, clusterer *cluster.Clusterer) {
	pollInterval := 1 * time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		pollCtx, cancel := context.WithTimeout(ctx, pollInterval)
		fetches := consumer.PollFetches(pollCtx)
		cancel()

		if errs := fetches.Errors(); len(errs) > 0 {
			for _, e := range errs {
				if e.Err != nil && e.Err != context.DeadlineExceeded && e.Err != context.Canceled {
					log.Error("fetch error", "topic", e.Topic, "partition", e.Partition, "err", e.Err)
				}
			}
		}

		n := 0
		fetches.EachRecord(func(r *kgo.Record) {
			n++
			var sig sentinelsignal.Signal
			if err := json.Unmarshal(r.Value, &sig); err != nil {
				log.Error("skipping malformed signal", "err", err)
				return
			}
			caseID, err := clusterer.Cluster(ctx, sig.TenantID, cluster.Signal{
				DedupeKey: sig.DedupeKey, SignalID: sig.SignalID, RuleID: sig.RuleID,
				EntityType: sig.EntityType, EntityID: sig.EntityID, Severity: sig.Severity,
				EventIDs: sig.EventIDs, DetectedAt: sig.DetectedAt, MitreIDs: sig.MitreIDs,
			})
			if err != nil {
				log.Error("clustering signal failed", "signal_id", sig.SignalID, "err", err)
				return
			}
			log.Info("signal clustered", "signal_id", sig.SignalID, "case_id", caseID)
		})

		if n > 0 {
			if err := consumer.CommitUncommittedOffsets(ctx); err != nil {
				log.Error("committing offsets, will retry next poll", "err", err)
			}
		}
	}
}

// runQuietPeriodSweep closes every tenant's own quiet cases on a fixed
// tick. Lists tenants via the pool's own default (superuser)
// connection, deliberately — this is a cross-tenant background sweep
// by construction, the same "sentinel_jobs"-shaped exception every
// other periodic, tenant-spanning job in this system already is; the
// actual close/transition writes still go through
// cluster.Clusterer.CloseQuietCases, which is tenant-scoped via
// sentineldb.WithTenantContext like everything else this package writes.
func runQuietPeriodSweep(ctx context.Context, log *slog.Logger, pool *pgxpool.Pool, clusterer *cluster.Clusterer, quietPeriod time.Duration) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	sweepOnce := func() {
		rows, err := pool.Query(ctx, `SELECT id FROM tenants`)
		if err != nil {
			log.Error("listing tenants for quiet-period sweep", "err", err)
			return
		}
		var tenantIDs []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				log.Error("scanning tenant id", "err", err)
				continue
			}
			tenantIDs = append(tenantIDs, id)
		}
		rows.Close()

		for _, tenantID := range tenantIDs {
			closed, err := clusterer.CloseQuietCases(ctx, tenantID, quietPeriod, time.Now().UTC())
			if err != nil {
				log.Error("closing quiet cases", "tenant_id", tenantID, "err", err)
				continue
			}
			if closed > 0 {
				log.Info("closed quiet cases", "tenant_id", tenantID, "count", closed)
			}
		}
	}

	sweepOnce()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweepOnce()
		}
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
