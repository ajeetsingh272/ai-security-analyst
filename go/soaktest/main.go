// Command soaktest is P1-12: the P1 exit criterion as an executable test —
// run the full connector -> stream -> ClickHouse pipeline continuously
// while injecting broker restarts, ClickHouse restarts, and vendor 429/503
// responses, then reconcile produced vs stored counts exactly.
//
// The real P1-04 OCSF normaliser (events.raw -> events.normalized) doesn't
// exist yet — blocked on a real connector, itself blocked on P1-02's OAuth
// credentials. This tool's own bridge (runBridge below) stands in for
// exactly that one stage — clearly test-only — so this harness still
// exercises the REAL connector scheduler (go/sentinelconnector), REAL
// Redpanda topics (go/sentinelstream), and the REAL eventwriter
// Consumer/ClickHouseWriter (go/sentinelevents) end to end, rather than
// skip the connector layer entirely the way P1-07's own loadtest does.
//
// A SEPARATE, opt-in program, matching go/sentinelevents/loadtest's own
// convention. Run explicitly:
//
//	go run ./go/soaktest -duration=15m -restart-every=5m
//
// A literal "72 hours continuous, no manual intervention" (the ticket's
// own AC) is not something a single coding session can run and wait out —
// see the PR/issue for the honest accounting of what was actually run
// during this work versus what this harness is BUILT to support: it has
// no hardcoded duration ceiling, and -duration=72h works exactly the same
// way -duration=10m does. Running it for the full 72 hours for real is a
// deliberate choice left to whoever operates this system, not something
// faked here by shortening the AC instead of the run.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"math/rand"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelevents"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/twmb/franz-go/pkg/kgo"
)

// A fixed, obviously-synthetic tenant — this harness seeds no real tenant
// row in Postgres at all (InMemoryCursorStore, no HealthRecorder), since
// nothing it does needs RLS or the control plane; it only exercises the
// stream + event-store planes.
const defaultSoakConnectorRowID = "soak-connector"

// failureMode picks which real infrastructure restart(s) runFailureInjection
// triggers — split out from the single "alternate both" behaviour the full
// 72h run uses so T1/T2 can each exercise exactly ONE failure kind
// deterministically, in a short, bounded test, without the other kind's
// restart landing at an uncontrolled moment in the middle of a short
// assertion window.
type failureMode int

const (
	failureModeAlternate failureMode = iota
	failureModeBrokerOnly
	failureModeClickHouseOnly
	failureModeNone
)

// Config is every knob main() exposes as a flag — pulled into its own type
// so runSoak is callable directly from tests (go/soaktest/soak_integration_test.go's
// T1/T2) with a short duration and a single failureMode, rather than only
// through the CLI.
type Config struct {
	TenantID       string
	ConnectorRowID string
	Duration       time.Duration
	Interval       time.Duration
	BatchSize      int
	FailRate       float64
	RestartEvery   time.Duration
	FailureMode    failureMode
	ReportPath     string
}

func main() {
	duration := flag.Duration("duration", 10*time.Minute, "how long to run — the ticket's own AC asks for 72h; see this file's own doc comment")
	interval := flag.Duration("interval", 2*time.Second, "connector scheduler poll interval — compressed for testing, not representative of a real vendor API's own rate")
	batchSize := flag.Int("batch-size", 500, "events returned per successful Fetch")
	failRate := flag.Float64("fail-rate", 0.15, "probability a given Fetch call returns a synthetic vendor 429/503 instead of succeeding")
	restartEvery := flag.Duration("restart-every", 3*time.Minute, "how often to alternate injecting a broker restart and a ClickHouse restart")
	reportPath := flag.String("report", "soaktest-report.json", "where to write the final reconciliation/lag/resource report")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg := Config{
		TenantID:       fmt.Sprintf("50000000-0000-4000-8000-%012d", time.Now().Unix()%1_000_000_000_000),
		ConnectorRowID: defaultSoakConnectorRowID,
		Duration:       *duration,
		Interval:       *interval,
		BatchSize:      *batchSize,
		FailRate:       *failRate,
		RestartEvery:   *restartEvery,
		FailureMode:    failureModeAlternate,
		ReportPath:     *reportPath,
	}

	report, err := runSoak(ctx, stop, cfg, log)
	if err != nil {
		log.Error("soak test failed to run", "err", err)
		os.Exit(1)
	}
	if err := writeReport(cfg.ReportPath, report); err != nil {
		log.Error("writing report", "err", err)
	}
	log.Info("soak test finished", "reconciled_exactly", report.ReconciledExactly, "produced", report.Produced,
		"stored_after_merge", report.StoredAfterMerge, "report_path", cfg.ReportPath)

	if !report.ReconciledExactly {
		os.Exit(1)
	}
}

// runSoak is the whole harness as a function, so both main() and this
// package's own integration tests drive the identical real pipeline —
// nothing about the test cases is a separate, simplified reimplementation
// of what the CLI does.
func runSoak(ctx context.Context, stop context.CancelFunc, cfg Config, log *slog.Logger) (Report, error) {
	rawProduceClient, err := kgo.NewClient(kgo.SeedBrokers("localhost:19092"))
	if err != nil {
		return Report{}, fmt.Errorf("soaktest: creating raw-produce client: %w", err)
	}
	defer rawProduceClient.Close()

	bridgeConsumeClient, err := kgo.NewClient(
		kgo.SeedBrokers("localhost:19092"),
		kgo.ConsumeTopics(sentinelstream.EventsRaw),
		kgo.ConsumerGroup("soaktest-bridge-"+fmt.Sprint(time.Now().UnixNano())),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtEnd()), // only this run's own traffic
	)
	if err != nil {
		return Report{}, fmt.Errorf("soaktest: creating bridge consume client: %w", err)
	}
	defer bridgeConsumeClient.Close()

	normalizedProduceClient, err := kgo.NewClient(kgo.SeedBrokers("localhost:19092"))
	if err != nil {
		return Report{}, fmt.Errorf("soaktest: creating normalized-produce client: %w", err)
	}
	defer normalizedProduceClient.Close()

	writerConsumeClient, err := kgo.NewClient(
		kgo.SeedBrokers("localhost:19092"),
		kgo.ConsumeTopics(sentinelstream.EventsNormalized),
		kgo.ConsumerGroup("soaktest-writer-"+fmt.Sprint(time.Now().UnixNano())),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtEnd()),
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		return Report{}, fmt.Errorf("soaktest: creating writer consume client: %w", err)
	}
	defer writerConsumeClient.Close()

	writer, err := sentinelevents.NewClickHouseWriter("localhost:9000", "sentinel", "default", "")
	if err != nil {
		return Report{}, fmt.Errorf("soaktest: connecting ClickHouse writer: %w", err)
	}
	defer writer.Close()

	var written atomic.Int64
	consumer := sentinelevents.NewConsumer(writerConsumeClient, writer, sentinelevents.ConsumerOptions{
		Trigger: sentinelevents.BatchTrigger{MaxRows: 2000, MaxAge: 2 * time.Second},
		Log:     log,
		OnWrite: func(n int) { written.Add(int64(n)) },
	})
	consumerDone := make(chan struct{})
	go func() {
		defer close(consumerDone)
		if err := consumer.Run(ctx); err != nil && ctx.Err() == nil {
			log.Error("consumer stopped unexpectedly", "err", err)
		}
	}()

	bridgeDone := make(chan struct{})
	go func() {
		defer close(bridgeDone)
		runBridge(ctx, bridgeConsumeClient, normalizedProduceClient, log)
	}()

	conn := &soakConnector{tenantID: cfg.TenantID, failRate: cfg.FailRate, batchSize: cfg.BatchSize}
	scheduler := sentinelconnector.NewScheduler(
		sentinelstream.NewRedpandaPublisher(rawProduceClient, sentinelstream.EventsRaw),
		sentinelconnector.NewInMemoryCursorStore(),
		sentinelconnector.SchedulerOptions{Interval: cfg.Interval, Log: log},
	)
	scheduler.Register(sentinelconnector.TenantConnector{
		TenantID: cfg.TenantID, ConnectorRowID: cfg.ConnectorRowID, Stream: "main", Connector: conn,
	})
	scheduler.Start(ctx)

	var brokerRestarts, clickhouseRestarts atomic.Int64
	injectionDone := make(chan struct{})
	go func() {
		defer close(injectionDone)
		runFailureInjection(ctx, cfg.RestartEvery, cfg.FailureMode, log, &brokerRestarts, &clickhouseRestarts)
	}()

	monitor := &resourceMonitor{}
	monitorDone := make(chan struct{})
	go func() {
		defer close(monitorDone)
		monitor.run(ctx, log, 10*time.Second)
	}()

	log.Info("soak test starting", "tenant_id", cfg.TenantID, "duration", cfg.Duration.String(), "interval", cfg.Interval.String(),
		"batch_size", cfg.BatchSize, "fail_rate", cfg.FailRate, "restart_every", cfg.RestartEvery.String())
	runStart := time.Now()

	select {
	case <-time.After(cfg.Duration):
	case <-ctx.Done():
		log.Info("interrupted early")
	}

	produced := conn.produced.Load()
	log.Info("run window finished, stopping the scheduler and draining", "produced", produced)

	// Stop the connector FIRST — no point draining against a producer that
	// is still adding more work — then let the bridge/consumer catch up to
	// what was already produced before tearing them down too.
	schedShutdownCtx, cancelSchedShutdown := context.WithTimeout(context.Background(), 30*time.Second)
	if err := scheduler.Shutdown(schedShutdownCtx); err != nil {
		log.Error("scheduler shutdown", "err", err)
	}
	cancelSchedShutdown()

	drainDeadline := time.Now().Add(2 * time.Minute)
	for written.Load() < produced && time.Now().Before(drainDeadline) {
		time.Sleep(1 * time.Second)
	}

	stop() // cancels ctx: bridge, consumer, failure-injection and resource-monitor loops all exit
	for _, done := range []chan struct{}{consumerDone, bridgeDone, injectionDone, monitorDone} {
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			log.Error("a goroutine did not stop within 10s of cancellation")
		}
	}

	reconcileCtx, cancelReconcile := context.WithTimeout(context.Background(), 2*time.Minute)
	storedCount, lagP50, lagP95, lagP99 := reconcile(reconcileCtx, cfg.TenantID, log)
	cancelReconcile()

	samples := monitor.snapshot()
	return buildReport(runStart, produced, written.Load(), storedCount, lagP50, lagP95, lagP99,
		conn.failuresInjected.Load(), brokerRestarts.Load(), clickhouseRestarts.Load(), samples), nil
}

// soakConnector is a synthetic Connector: deterministic given its cursor
// (ADR-0010's Fetch-must-be-idempotent contract), so a retry after a
// synthetic vendor failure reproduces the exact same batch rather than
// skipping or duplicating events — the property that makes "produced
// count reconciles exactly with stored count" achievable at all.
type soakConnector struct {
	tenantID  string
	failRate  float64
	batchSize int

	produced         atomic.Int64
	failuresInjected atomic.Int64
}

func (c *soakConnector) ID() sentinelconnector.ConnectorID { return "soaktest" }

type soakCursor struct {
	Seq int64 `json:"seq"`
}

func (c *soakConnector) Fetch(_ context.Context, cur sentinelconnector.Cursor) (sentinelconnector.Batch, sentinelconnector.Cursor, error) {
	var sc soakCursor
	if len(cur) > 0 {
		if err := json.Unmarshal(cur, &sc); err != nil {
			return sentinelconnector.Batch{}, nil, fmt.Errorf("soaktest: unmarshalling cursor: %w", err)
		}
	}

	if rand.Float64() < c.failRate {
		c.failuresInjected.Add(1)
		if rand.Intn(2) == 0 {
			return sentinelconnector.Batch{}, nil, errors.New("soaktest: synthetic vendor error: 429 too many requests")
		}
		return sentinelconnector.Batch{}, nil, errors.New("soaktest: synthetic vendor error: 503 service unavailable")
	}

	events := make([]sentinelconnector.RawEvent, c.batchSize)
	for i := 0; i < c.batchSize; i++ {
		payload, _ := json.Marshal(soakCursor{Seq: sc.Seq + int64(i)})
		events[i] = sentinelconnector.RawEvent{TenantID: c.tenantID, Payload: payload}
	}
	c.produced.Add(int64(c.batchSize))

	nextCur, _ := json.Marshal(soakCursor{Seq: sc.Seq + int64(c.batchSize)})
	return sentinelconnector.Batch{Events: events}, sentinelconnector.Cursor(nextCur), nil
}

func (c *soakConnector) Normalise(raw sentinelconnector.RawEvent) ([]ocsf.Event, error) {
	var p soakCursor
	if err := json.Unmarshal(raw.Payload, &p); err != nil {
		return nil, fmt.Errorf("soaktest: unmarshalling raw payload: %w", err)
	}
	return []ocsf.Event{{
		ClassUID: 3002, CategoryUID: 3, ActivityID: 1, TypeUID: 300201, SeverityID: 1,
		// Set at normalise time, not at final storage — this is the
		// upstream half of the end-to-end lag reconcile() measures via
		// ClickHouse's own ingested_at - time.
		TimeUnixMillis: time.Now().UnixMilli(),
		TenantID:       raw.TenantID,
		Metadata:       map[string]string{"event_id": fmt.Sprintf("soak-%d", p.Seq)},
		RawData:        raw.Payload,
	}}, nil
}

func (c *soakConnector) HealthCheck(context.Context) error { return nil }

// runBridge stands in for P1-04's not-yet-built OCSF normaliser: reads
// events.raw (what the real connector scheduler publishes), reshapes each
// ocsf.Event into the EventRow wire format go/sentinelevents' real
// Consumer expects, and republishes to events.normalized. Test-only code —
// a real normaliser would do actual OCSF conformance mapping, not this
// mechanical field copy.
func runBridge(ctx context.Context, consumeClient, produceClient *kgo.Client, log *slog.Logger) {
	for {
		fetches := consumeClient.PollFetches(ctx)
		if ctx.Err() != nil {
			return
		}
		fetches.EachError(func(_ string, _ int32, err error) {
			if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
				log.Error("bridge: fetch error", "err", err)
			}
		})

		var records []*kgo.Record
		fetches.EachRecord(func(rec *kgo.Record) {
			var ev ocsf.Event
			if err := json.Unmarshal(rec.Value, &ev); err != nil {
				log.Error("bridge: unmarshalling raw event", "err", err)
				return
			}
			row := sentinelevents.EventRow{
				TenantID:    ev.TenantID,
				EventID:     ev.Metadata["event_id"],
				Time:        time.UnixMilli(ev.TimeUnixMillis),
				ClassUID:    uint32(ev.ClassUID),
				CategoryUID: uint16(ev.CategoryUID),
				ActivityID:  uint16(ev.ActivityID),
				TypeUID:     uint32(ev.TypeUID),
				SeverityID:  uint8(ev.SeverityID),
				Message:     "soak test event",
			}
			payload, err := json.Marshal(row)
			if err != nil {
				log.Error("bridge: marshalling event row", "err", err)
				return
			}
			records = append(records, &kgo.Record{
				Topic: sentinelstream.EventsNormalized,
				Key:   []byte(ev.TenantID + ":0"),
				Value: payload,
			})
		})

		if len(records) > 0 {
			for _, res := range produceClient.ProduceSync(ctx, records...) {
				if res.Err != nil && ctx.Err() == nil {
					log.Error("bridge: producing to events.normalized", "err", res.Err)
				}
			}
		}
	}
}

// runFailureInjection is the ticket's "injects broker restart, ClickHouse
// restart" half of AC2 — a REAL `docker compose restart`, not a pause,
// since the AC's own word is "restart" and both services already have
// persistent volumes and healthchecks that make a real restart safe and
// observable. mode picks whether it alternates both (the full soak run)
// or sticks to exactly one (T1/T2's own deterministic, bounded tests).
func runFailureInjection(ctx context.Context, every time.Duration, mode failureMode, log *slog.Logger, brokerRestarts, clickhouseRestarts *atomic.Int64) {
	if mode == failureModeNone {
		<-ctx.Done()
		return
	}

	ticker := time.NewTicker(every)
	defer ticker.Stop()

	toggle := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			service := "redpanda"
			switch mode {
			case failureModeBrokerOnly:
				service = "redpanda"
			case failureModeClickHouseOnly:
				service = "clickhouse"
			default: // failureModeAlternate
				if toggle%2 == 1 {
					service = "clickhouse"
				}
				toggle++
			}
			if service == "redpanda" {
				brokerRestarts.Add(1)
			} else {
				clickhouseRestarts.Add(1)
			}
			log.Info("failure injection: restarting service", "service", service)
			restartService(ctx, service, log)
		}
	}
}

func restartService(ctx context.Context, service string, log *slog.Logger) {
	cmd := exec.CommandContext(ctx, "docker", "compose", "-f", "infra/docker/docker-compose.dev.yml", "restart", service)
	cmd.Dir = repoRoot()
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Error("failure injection: restart failed", "service", service, "err", err, "output", string(out))
		return
	}
	waitForHealthy(ctx, service, log, 2*time.Minute)
}

func waitForHealthy(ctx context.Context, service string, log *slog.Logger, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return
		}
		cmd := exec.CommandContext(ctx, "docker", "compose", "-f", "infra/docker/docker-compose.dev.yml", "ps", service, "--format", "{{.Health}}")
		cmd.Dir = repoRoot()
		out, _ := cmd.Output()
		if strings.TrimSpace(string(out)) == "healthy" {
			log.Info("failure injection: service healthy again", "service", service)
			return
		}
		time.Sleep(2 * time.Second)
	}
	log.Error("failure injection: service did not report healthy within timeout", "service", service, "timeout", timeout.String())
}

func repoRoot() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..")
}

type resourceSample struct {
	AtUnixMillis   int64  `json:"at_unix_millis"`
	Goroutines     int    `json:"goroutines"`
	HeapAllocBytes uint64 `json:"heap_alloc_bytes"`
}

// resourceMonitor is T3's own mechanism — AC's "memory and goroutine
// counts are stable" — sampled periodically for the whole run, with every
// sample kept in the final report so a real 72-hour run (not just this
// session's shorter demonstration) has a genuine trend to inspect, not
// just a start/end snapshot that could hide a slow leak in between.
type resourceMonitor struct {
	mu      sync.Mutex
	samples []resourceSample
}

func (m *resourceMonitor) run(ctx context.Context, log *slog.Logger, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()

	record := func() {
		var ms runtime.MemStats
		runtime.ReadMemStats(&ms)
		s := resourceSample{AtUnixMillis: time.Now().UnixMilli(), Goroutines: runtime.NumGoroutine(), HeapAllocBytes: ms.HeapAlloc}
		m.mu.Lock()
		m.samples = append(m.samples, s)
		m.mu.Unlock()
		log.Info("resource sample", "goroutines", s.Goroutines, "heap_alloc_mb", s.HeapAllocBytes/1024/1024)
	}

	record()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			record()
		}
	}
}

func (m *resourceMonitor) snapshot() []resourceSample {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]resourceSample(nil), m.samples...)
}

// reconcile is the ticket's central claim — "produced count reconciles
// exactly with stored count after merge" — plus the lag-distribution half
// of the required written report, both read straight from ClickHouse
// rather than tracked separately in this process, so a bug in THIS
// harness's own bookkeeping can't accidentally make the reconciliation
// look better than the data actually is.
func reconcile(ctx context.Context, tenantID string, log *slog.Logger) (storedCount int64, lagP50, lagP95, lagP99 float64) {
	// A failure-injection restart can legitimately still be finishing when
	// a run window closes — not just a short test's timing, but the real
	// 72h run too, since nothing synchronises "the last scheduled restart
	// has fully recovered" with "the run duration elapsed". Retrying the
	// connection (and the first query against it) for up to a minute turns
	// that into "reconcile waits a few extra seconds", not a spurious
	// reconciliation failure that has nothing to do with whether the data
	// actually reconciles. Found this the direct way: a restart timed to
	// land right at a short test's own end produced exactly this failure
	// mode (a raw driver EOF, not stored=0 from a genuine mismatch).
	var conn clickhouse.Conn
	var err error
	deadline := time.Now().Add(1 * time.Minute)
	for {
		conn, err = clickhouse.Open(&clickhouse.Options{Addr: []string{"localhost:9000"}, Auth: clickhouse.Auth{Database: "sentinel", Username: "default"}})
		if err == nil {
			if pingErr := conn.Exec(ctx, "SELECT 1"); pingErr == nil {
				break
			} else {
				err = pingErr
				_ = conn.Close()
			}
		}
		if time.Now().After(deadline) {
			log.Error("reconcile: connecting to clickhouse", "err", err)
			return 0, 0, 0, 0
		}
		time.Sleep(2 * time.Second)
	}
	defer conn.Close()

	// Forces ReplacingMergeTree's dedup to actually resolve before
	// counting — an unmerged part could still hold a since-superseded
	// duplicate version, which would otherwise inflate the count above
	// what is "currently true" for this tenant.
	if err := conn.Exec(ctx, "OPTIMIZE TABLE sentinel.events FINAL"); err != nil {
		log.Error("reconcile: OPTIMIZE TABLE FINAL", "err", err)
	}

	// count() is ClickHouse's UInt64, not a signed int — the driver's Scan
	// requires the exact matching pointer type (confirmed the hard way:
	// scanning into *int64 directly fails with "converting UInt64 to
	// *int64 is unsupported"), same reason loadtest.go's own
	// monitorMergeQueue already scans its system.parts/system.merges
	// counts into uint64 rather than int.
	var storedCountU uint64
	countQuery := fmt.Sprintf("SELECT count() FROM sentinel.events WHERE tenant_id = '%s'", tenantID)
	if err := conn.QueryRow(ctx, countQuery).Scan(&storedCountU); err != nil {
		log.Error("reconcile: counting stored rows", "err", err)
	}
	storedCount = int64(storedCountU)

	lagQuery := fmt.Sprintf(
		`SELECT quantile(0.50)(lag_ms), quantile(0.95)(lag_ms), quantile(0.99)(lag_ms) FROM (
			SELECT (toUnixTimestamp64Milli(ingested_at) - toUnixTimestamp64Milli(time)) AS lag_ms
			FROM sentinel.events WHERE tenant_id = '%s'
		)`, tenantID)
	if err := conn.QueryRow(ctx, lagQuery).Scan(&lagP50, &lagP95, &lagP99); err != nil {
		log.Error("reconcile: computing lag distribution", "err", err)
	}

	return storedCount, lagP50, lagP95, lagP99
}

// Report is the ticket's required "written report of lag distribution and
// failure recovery times" (recovery time itself is implicit in how long
// each restartService call above took to report healthy again, logged at
// the time rather than duplicated here — the structured JSON logs this
// program emits ARE that record).
type Report struct {
	StartedAt              time.Time        `json:"started_at"`
	Duration               string           `json:"duration"`
	Produced               int64            `json:"produced"`
	WrittenByConsumer      int64            `json:"written_by_consumer"`
	StoredAfterMerge       int64            `json:"stored_after_merge"`
	ReconciledExactly      bool             `json:"reconciled_exactly"`
	VendorFailuresInjected int64            `json:"vendor_failures_injected"`
	BrokerRestarts         int64            `json:"broker_restarts"`
	ClickHouseRestarts     int64            `json:"clickhouse_restarts"`
	LagP50Ms               float64          `json:"lag_p50_ms"`
	LagP95Ms               float64          `json:"lag_p95_ms"`
	LagP99Ms               float64          `json:"lag_p99_ms"`
	ResourceSamples        []resourceSample `json:"resource_samples"`
	ScopeNote              string           `json:"scope_note"`
}

func buildReport(
	startedAt time.Time, produced, written, stored int64,
	lagP50, lagP95, lagP99 float64,
	vendorFailures, brokerRestarts, clickhouseRestarts int64,
	samples []resourceSample,
) Report {
	return Report{
		StartedAt:              startedAt,
		Duration:               time.Since(startedAt).Round(time.Second).String(),
		Produced:               produced,
		WrittenByConsumer:      written,
		StoredAfterMerge:       stored,
		ReconciledExactly:      stored == produced,
		VendorFailuresInjected: vendorFailures,
		BrokerRestarts:         brokerRestarts,
		ClickHouseRestarts:     clickhouseRestarts,
		LagP50Ms:               lagP50,
		LagP95Ms:               lagP95,
		LagP99Ms:               lagP99,
		ResourceSamples:        samples,
		ScopeNote: "P1-12's own AC asks for 72 hours continuous; this run's -duration flag is in the " +
			"accompanying log/PR, not hardcoded here. See go/soaktest/main.go's own doc comment and the " +
			"PR description for the honest accounting of what was run versus what this harness supports.",
	}
}

func writeReport(path string, report Report) error {
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return fmt.Errorf("soaktest: marshalling report: %w", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("soaktest: writing report to %s: %w", path, err)
	}
	return nil
}
