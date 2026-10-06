// Command eventwriter consumes normalised events from Redpanda and writes
// them to ClickHouse in batches, committing offsets only after each batch
// is durably written (P1-07, ADR-0005's risk table: "Batched inserts
// (never per-row), async insert mode, monitored merge queue depth with an
// alert").
//
// A separate deployable from `ingest` (services/ingest) on purpose: the two
// have different scaling characteristics — ingest's throughput is bounded
// by how many connectors are polling, this one's by how fast ClickHouse
// accepts batches — and a slow ClickHouse here must never backpressure a
// connector's vendor API polling over there. Keeping them as separate
// processes is what makes that true structurally, not just by convention.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelevents"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelobs"
	"github.com/twmb/franz-go/pkg/kgo"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

const serviceName = "sentinel-eventwriter"

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

	writer, err := sentinelevents.NewClickHouseWriter(
		envOr("CLICKHOUSE_ADDR", "localhost:9000"),
		envOr("CLICKHOUSE_DATABASE", "sentinel"),
		envOr("CLICKHOUSE_USER", "default"),
		envOr("CLICKHOUSE_PASSWORD", ""),
	)
	if err != nil {
		log.Error("connecting to ClickHouse", "err", err)
		os.Exit(1)
	}
	defer writer.Close()

	invalidRows, err := otel.Meter(serviceName).Int64Counter("eventwriter.invalid_rows",
		metric.WithDescription("Rows ClickHouse rejected for a data reason and this writer dropped rather than retrying forever"))
	if err != nil {
		log.Error("creating eventwriter.invalid_rows counter", "err", err)
		os.Exit(1)
	}

	// A dedicated client for the one thing it does — publish a dropped row
	// to events.normalized.dlq (P1-05 provisions this topic; nothing wrote
	// to it until now). Separate from the consumer's own client below:
	// producing and a joined consumer group are two different concerns,
	// and this one needs no group membership or offset tracking at all.
	dlqClient, err := kgo.NewClient(kgo.SeedBrokers(envOr("REDPANDA_BROKERS", "localhost:19092")))
	if err != nil {
		log.Error("creating DLQ producer client", "err", err)
		os.Exit(1)
	}
	defer dlqClient.Close()

	writer.OnInvalidRow(func(row sentinelevents.EventRow, writeErr error) {
		invalidRows.Add(context.Background(), 1)
		log.Error("dropped invalid row, routing to DLQ", "event_id", row.EventID, "tenant_id", row.TenantID, "err", writeErr)
		payload, marshalErr := json.Marshal(row)
		if marshalErr != nil {
			log.Error("marshalling dropped row for DLQ", "event_id", row.EventID, "err", marshalErr)
			return
		}
		dlqCtx, dlqCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer dlqCancel()
		result := dlqClient.ProduceSync(dlqCtx, &kgo.Record{
			Topic: "events.normalized.dlq",
			Key:   []byte(row.TenantID),
			Value: payload,
		})
		if err := result.FirstErr(); err != nil {
			// The row is already logged above with its full error — this
			// is a second, independent failure (DLQ publish itself), not a
			// reason to retry the ClickHouse write again.
			log.Error("publishing dropped row to DLQ failed", "event_id", row.EventID, "err", err)
		}
	})

	kafkaClient, err := kgo.NewClient(
		kgo.SeedBrokers(envOr("REDPANDA_BROKERS", "localhost:19092")),
		kgo.ConsumeTopics("events.normalized"),
		kgo.ConsumerGroup(envOr("CONSUMER_GROUP", "eventwriter")),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		// Offsets commit only after ClickHouse acknowledges the write
		// (AC2) — auto-commit would ack Kafka before the data is durable
		// anywhere, exactly the false-ack ordering ADR-0010 exists to
		// prevent on the producer side.
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		log.Error("creating kafka client", "err", err)
		os.Exit(1)
	}
	defer kafkaClient.Close()

	batchRowCount, err := otel.Meter(serviceName).Int64Counter("eventwriter.batch_rows",
		metric.WithDescription("Rows written per successful batch (AC4: merge queue pressure proxy)"))
	if err != nil {
		log.Error("creating eventwriter.batch_rows counter", "err", err)
		os.Exit(1)
	}

	consumer := sentinelevents.NewConsumer(kafkaClient, writer, sentinelevents.ConsumerOptions{
		Trigger: sentinelevents.BatchTrigger{
			MaxRows: envIntOr("BATCH_MAX_ROWS", 10000),
			MaxAge:  envDurationOr("BATCH_MAX_AGE", 2*time.Second),
		},
		Log: log,
		OnWrite: func(n int) {
			batchRowCount.Add(context.Background(), int64(n))
		},
	})

	go monitorMergeQueue(ctx, log, envOr("CLICKHOUSE_ADDR", "localhost:9000"))

	consumerDone := make(chan struct{})
	go func() {
		defer close(consumerDone)
		if err := consumer.Run(ctx); err != nil && ctx.Err() == nil {
			log.Error("consumer stopped unexpectedly", "err", err)
			stop()
		}
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
		Addr:              envOr("EVENTWRITER_ADDR", ":8102"),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		log.Info("eventwriter listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen failed", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("draining in-flight batches before exit")

	shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		log.Error("http shutdown", "err", err)
	}
	select {
	case <-consumerDone:
	case <-shutdown.Done():
		log.Error("consumer did not stop within the shutdown deadline")
	}
	log.Info("eventwriter stopped")
}

// monitorMergeQueue polls ClickHouse's own view of its merge backlog —
// AC4, "merge queue depth is monitored". The alert ITSELF is infrastructure
// this service doesn't own (no Alertmanager exists yet in this backlog);
// this is the mechanism and the metric, same "here, not the dashboard"
// split P1-01 used for connector health.
func monitorMergeQueue(ctx context.Context, log *slog.Logger, addr string) {
	activeParts, err := otel.Meter(serviceName).Int64Gauge("clickhouse.events_active_parts",
		metric.WithDescription("Active parts in sentinel.events — a sustained climb means merges are losing to insert rate"))
	if err != nil {
		log.Error("creating clickhouse.events_active_parts gauge", "err", err)
		return
	}
	activeMerges, err := otel.Meter(serviceName).Int64Gauge("clickhouse.events_active_merges",
		metric.WithDescription("In-flight background merges on sentinel.events"))
	if err != nil {
		log.Error("creating clickhouse.events_active_merges gauge", "err", err)
		return
	}

	conn, err := clickhouse.Open(&clickhouse.Options{Addr: []string{addr}, Auth: clickhouse.Auth{Database: "sentinel", Username: "default"}})
	if err != nil {
		log.Error("merge queue monitor: connecting", "err", err)
		return
	}
	defer conn.Close()

	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			var parts, merges int64
			if err := conn.QueryRow(ctx, "SELECT count() FROM system.parts WHERE table = 'events' AND active").Scan(&parts); err != nil {
				log.Error("merge queue monitor: querying active parts", "err", err)
				continue
			}
			if err := conn.QueryRow(ctx, "SELECT count() FROM system.merges WHERE table = 'events'").Scan(&merges); err != nil {
				log.Error("merge queue monitor: querying active merges", "err", err)
				continue
			}
			activeParts.Record(ctx, parts)
			activeMerges.Record(ctx, merges)
		}
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envIntOr(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func envDurationOr(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return fallback
	}
	return d
}
