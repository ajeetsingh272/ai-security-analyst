// Package loadtest is P2-11: the detection engine's own exit-criterion
// harness — "30k EPS sustained for one hour, p99 under 100ms, no
// goroutine/memory leak" — as an executable, repeatable test rather than
// a one-off manual exercise.
//
// Deliberately NOT a new k6/JS toolchain dependency: the ticket says "k6
// OR EQUIVALENT", and this repo already has two Go-based load/soak
// harnesses of its own (go/soaktest, go/sentinelevents/loadtest) with an
// established Config-struct-callable-from-both-main-and-a-test
// convention. This package follows that convention rather than
// reinventing one.
//
// Only the in-stream worker is exercised. P2-11 depends on P2-04/P2-03
// (both in-stream), and "p99 under 100ms" cannot describe the windowed
// engine by construction — a windowed rule's own schedule interval is
// 30s-15min (windowed.levelInterval), so its own detection latency is
// bounded by the schedule, not the pipeline. Measuring it here would be
// measuring the wrong thing.
//
// No change to production code was needed to measure latency: every
// emitted Signal already carries DetectedAt (sentinelsignal.Signal, set
// by worker.evaluate() at the moment a rule matches). This harness
// tracks its own produce-time per matching event's EventID and computes
// latency as DetectedAt minus that produce-time on receipt — an honest,
// real, end-to-end measurement, entirely from the OUTSIDE of worker.go,
// with nothing added to the hot path just to make this test possible.
package loadtest

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelsignal"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/detectgen"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/dispatch"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/worker"
	"github.com/twmb/franz-go/pkg/kgo"
)

// newInboxForwardingRuleID is the same known, real rule
// services/detect/internal/worker's own load_test.go already uses to
// prove the signal-publish path is genuinely exercised under load, not
// bypassed — reused here rather than inventing a second synthetic
// trigger for the identical purpose.
const newInboxForwardingRuleID = "8f1a2b3c-0001-4a00-9000-000000000001"

// Config is every knob the CLI (cmd/loadtest) exposes as a flag — pulled
// into its own type so Run is callable directly from the CI regression
// gate test (harness_integration_test.go) with a short duration and a
// reduced rate, the same reason go/soaktest.Config exists.
type Config struct {
	Brokers string
	// TargetEPS is the overall event rate across every worker combined.
	TargetEPS int
	Duration  time.Duration
	// WorkerCount mirrors worker's own T3 (load_test.go) — several real
	// Worker instances in one consumer group, not a single-threaded loop.
	WorkerCount int
	// MatchEveryN: 1 event in N is crafted to match
	// newInboxForwardingRuleID, so the signal-publish path (and the
	// latency this harness measures) is genuinely exercised, not just
	// raw throughput against events that never produce a signal.
	MatchEveryN int
	// DrainGrace is how long to keep consuming signals after production
	// stops, so the last in-flight events are not counted as dropped
	// just because the deadline landed mid-flight.
	DrainGrace time.Duration
	// Warmup is how long to let the worker set's consumer group finish
	// joining/rebalancing BEFORE any latency sample is tracked — without
	// this, a short run's own p99 is dominated by one-time group-join
	// overhead that has nothing to do with steady-state pipeline latency
	// (confirmed directly: a 15s/2000EPS calibration run measured p99 of
	// 118ms before this existed, entirely explained by the first few
	// matched events landing during group rebalance). Negligible next to
	// a real 1-hour run's own duration.
	Warmup time.Duration
	// SampleEvery is the resource monitor's sampling interval.
	SampleEvery time.Duration
	Log         *slog.Logger
}

func (c Config) withDefaults() Config {
	if c.WorkerCount == 0 {
		c.WorkerCount = 4
	}
	if c.MatchEveryN == 0 {
		c.MatchEveryN = 500
	}
	if c.DrainGrace == 0 {
		c.DrainGrace = 30 * time.Second
	}
	if c.Warmup == 0 {
		c.Warmup = 3 * time.Second
	}
	if c.SampleEvery == 0 {
		c.SampleEvery = 10 * time.Second
	}
	if c.Log == nil {
		c.Log = slog.Default()
	}
	return c
}

// Report is the ticket's required "results are recorded" — written to
// disk as JSON by cmd/loadtest, and returned directly to
// harness_integration_test.go for the CI regression gate.
type Report struct {
	StartedAt       time.Time        `json:"started_at"`
	Duration        string           `json:"duration"`
	TargetEPS       int              `json:"target_eps"`
	WorkerCount     int              `json:"worker_count"`
	Produced        int64            `json:"produced"`
	AchievedEPS     float64          `json:"achieved_eps"`
	SignalsExpected int64            `json:"signals_expected"`
	SignalsReceived int64            `json:"signals_received"`
	LatencyP50Ms    float64          `json:"latency_p50_ms"`
	LatencyP95Ms    float64          `json:"latency_p95_ms"`
	LatencyP99Ms    float64          `json:"latency_p99_ms"`
	GoroutinesStart int              `json:"goroutines_start"`
	GoroutinesEnd   int              `json:"goroutines_end"`
	GoroutinesPeak  int              `json:"goroutines_peak"`
	HeapAllocPeakMB float64          `json:"heap_alloc_peak_mb"`
	ResourceSamples []resourceSample `json:"resource_samples"`
}

type resourceSample struct {
	AtUnixMillis   int64  `json:"at_unix_millis"`
	Goroutines     int    `json:"goroutines"`
	HeapAllocBytes uint64 `json:"heap_alloc_bytes"`
}

// resourceMonitor mirrors go/soaktest's own mechanism verbatim (same
// field shapes, same sampling loop) — P2-11's own T2 ("memory stable,
// no goroutine leak") is the identical class of claim P1-12's T3 already
// proves for a different pipeline, and there is no reason for the two
// measuring mechanisms to differ.
type resourceMonitor struct {
	mu      sync.Mutex
	samples []resourceSample
}

func (m *resourceMonitor) run(ctx context.Context, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	record := func() {
		var ms runtime.MemStats
		runtime.ReadMemStats(&ms)
		s := resourceSample{AtUnixMillis: time.Now().UnixMilli(), Goroutines: runtime.NumGoroutine(), HeapAllocBytes: ms.HeapAlloc}
		m.mu.Lock()
		m.samples = append(m.samples, s)
		m.mu.Unlock()
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

// corpusDir mirrors cmd/detect/main.go's own helper of the same name —
// duplicated rather than exported from main, the same "a small
// duplicated helper is fine, an import of another binary's main package
// is not" reasoning already applied elsewhere in this service.
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

func buildTree() (*dispatch.Tree, error) {
	dir, err := corpusDir()
	if err != nil {
		return nil, fmt.Errorf("loadtest: locating detections/rules: %w", err)
	}
	rules, errs := sigmac.ParseCorpus(dir)
	if len(errs) != 0 {
		return nil, fmt.Errorf("loadtest: parsing rule corpus: %v", errs)
	}
	return dispatch.Build(rules, detectgen.Rules, dispatch.Options{})
}

// Run executes one load-test pass: workerCount real Worker instances in
// one consumer group absorb a producer sustaining targetEPS for
// Duration, a fraction of events crafted to match a real rule so the
// signal-publish path is genuinely exercised, with end-to-end latency
// (produce time -> Signal.DetectedAt) and resource usage tracked
// throughout.
func Run(ctx context.Context, cfg Config) (Report, error) {
	cfg = cfg.withDefaults()
	log := cfg.Log

	tree, err := buildTree()
	if err != nil {
		return Report{}, err
	}

	runID := fmt.Sprintf("loadtest-%d", time.Now().UnixNano())
	group := "loadtest-" + runID

	workers := make([]*worker.Worker, cfg.WorkerCount)
	consumers := make([]*kgo.Client, cfg.WorkerCount)
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	for i := 0; i < cfg.WorkerCount; i++ {
		consumer, err := kgo.NewClient(
			kgo.SeedBrokers(cfg.Brokers),
			kgo.ConsumeTopics(sentinelstream.EventsNormalized),
			kgo.ConsumerGroup(group),
			kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
			kgo.DisableAutoCommit(),
		)
		if err != nil {
			return Report{}, fmt.Errorf("loadtest: creating consumer %d: %w", i, err)
		}
		producer, err := kgo.NewClient(kgo.SeedBrokers(cfg.Brokers))
		if err != nil {
			return Report{}, fmt.Errorf("loadtest: creating producer %d: %w", i, err)
		}
		consumers[i] = consumer
		workers[i] = worker.New(tree, consumer, producer, worker.Options{Group: group, Log: log})
		defer producer.Close()
		defer consumer.Close()
		go func(w *worker.Worker) { _ = w.Run(runCtx) }(workers[i])
	}

	monitor := &resourceMonitor{}
	monCtx, cancelMon := context.WithCancel(context.Background())
	defer cancelMon()
	go monitor.run(monCtx, cfg.SampleEvery)

	// Let the consumer group finish joining before any event that could
	// be sampled for latency is produced — see Config.Warmup's own doc
	// comment for why.
	time.Sleep(cfg.Warmup)

	// produceTimes tracks ONLY the crafted-to-match subset — the only
	// events this harness can correlate to a resulting Signal. At 30k
	// EPS for an hour with MatchEveryN=500, that is still only ~216k
	// entries (small strings -> time.Time), bounded and pruned as each
	// one is matched, so this stays flat across a long run rather than
	// growing with total events produced.
	var produceTimes sync.Map // eventID -> time.Time
	var produced, signalsExpected atomic.Int64

	produceCtx, cancelProduce := context.WithTimeout(context.Background(), cfg.Duration)
	defer cancelProduce()
	producerDone := make(chan struct{})
	go func() {
		defer close(producerDone)
		produceLoad(produceCtx, cfg, runID, &produceTimes, &produced, &signalsExpected)
	}()

	var latenciesMu sync.Mutex
	var latencies []float64
	var signalsReceived atomic.Int64
	collectCtx, cancelCollect := context.WithCancel(context.Background())
	defer cancelCollect()
	collectorDone := make(chan struct{})
	go func() {
		defer close(collectorDone)
		collectSignalsForLatency(collectCtx, cfg.Brokers, runID, &produceTimes, &latenciesMu, &latencies, &signalsReceived)
	}()

	startedAt := time.Now()
	<-producerDone
	// AchievedEPS must divide by the PRODUCTION window only — the drain
	// grace below exists so trailing in-flight signals are not missed,
	// not as more time to spread the same event count across, which
	// would understate the real achieved rate.
	produceElapsed := time.Since(startedAt)

	// Grace period: let the last in-flight batch's signals arrive before
	// tearing anything down.
	select {
	case <-time.After(cfg.DrainGrace):
	case <-ctx.Done():
	}

	cancelCollect()
	<-collectorDone
	cancelRun()
	cancelMon()
	time.Sleep(200 * time.Millisecond) // let Run's own poll loops notice cancellation quietly

	elapsed := time.Since(startedAt)
	samples := monitor.snapshot()

	latenciesMu.Lock()
	sort.Float64s(latencies)
	p50, p95, p99 := percentile(latencies, 0.50), percentile(latencies, 0.95), percentile(latencies, 0.99)
	latenciesMu.Unlock()

	var goroutinesStart, goroutinesEnd, goroutinesPeak int
	var heapPeak uint64
	if len(samples) > 0 {
		goroutinesStart = samples[0].Goroutines
		goroutinesEnd = samples[len(samples)-1].Goroutines
		for _, s := range samples {
			if s.Goroutines > goroutinesPeak {
				goroutinesPeak = s.Goroutines
			}
			if s.HeapAllocBytes > heapPeak {
				heapPeak = s.HeapAllocBytes
			}
		}
	}

	return Report{
		StartedAt:       startedAt,
		Duration:        elapsed.Round(time.Second).String(),
		TargetEPS:       cfg.TargetEPS,
		WorkerCount:     cfg.WorkerCount,
		Produced:        produced.Load(),
		AchievedEPS:     float64(produced.Load()) / produceElapsed.Seconds(),
		SignalsExpected: signalsExpected.Load(),
		SignalsReceived: signalsReceived.Load(),
		LatencyP50Ms:    p50,
		LatencyP95Ms:    p95,
		LatencyP99Ms:    p99,
		GoroutinesStart: goroutinesStart,
		GoroutinesEnd:   goroutinesEnd,
		GoroutinesPeak:  goroutinesPeak,
		HeapAllocPeakMB: float64(heapPeak) / 1024 / 1024,
		ResourceSamples: samples,
	}, nil
}

// produceLoad paces production to cfg.TargetEPS via a per-batch sleep —
// the same token-bucket-by-batch shape worker/load_test.go and
// go/soaktest's own generator already use.
func produceLoad(ctx context.Context, cfg Config, runID string, produceTimes *sync.Map, produced, signalsExpected *atomic.Int64) {
	producer, err := kgo.NewClient(kgo.SeedBrokers(cfg.Brokers))
	if err != nil {
		cfg.Log.Error("loadtest: creating load producer", "err", err)
		return
	}
	defer producer.Close()

	tenantID := runID
	const batchSize = 500
	secondsPerBatch := float64(batchSize) / float64(cfg.TargetEPS)
	batchInterval := time.Duration(secondsPerBatch * float64(time.Second))

	var idx int64
	var wg sync.WaitGroup
	for {
		if ctx.Err() != nil {
			break
		}
		batchStart := time.Now()
		for i := 0; i < batchSize; i++ {
			n := idx
			idx++
			eventID := fmt.Sprintf("%s-%d", runID, n)
			operation := "Send"
			if n%int64(cfg.MatchEveryN) == 0 {
				operation = "New-InboxRule"
				produceTimes.Store(eventID, time.Now())
				signalsExpected.Add(1)
			}
			payload, err := json.Marshal(wireEventJSON{
				TenantID: tenantID, EventID: eventID,
				ClassUID: 3005, ActivityID: 1, SeverityID: 1,
				Metadata: map[string]string{"product": "m365", "operation": operation},
			})
			if err != nil {
				continue
			}
			wg.Add(1)
			producer.Produce(context.Background(), &kgo.Record{
				Topic: sentinelstream.EventsNormalized,
				Key:   []byte(fmt.Sprintf("%s:%d", tenantID, n%64)),
				Value: payload,
			}, func(_ *kgo.Record, err error) {
				defer wg.Done()
				if err == nil {
					produced.Add(1)
				}
			})
		}
		if elapsed := time.Since(batchStart); elapsed < batchInterval {
			time.Sleep(batchInterval - elapsed)
		}
	}
	wg.Wait()
}

// wireEventJSON mirrors worker.wireEvent's own wire shape field-for-field
// — this package deliberately does not import the unexported type
// itself (it lives in internal/worker, not exported), the same "this is
// what's actually on the wire, kept local" reasoning worker.go's own
// wireEvent doc comment gives for not importing sentinelconnector.
type wireEventJSON struct {
	TenantID    string            `json:"tenant_id"`
	EventID     string            `json:"event_id"`
	ClassUID    uint32            `json:"class_uid"`
	CategoryUID uint16            `json:"category_uid"`
	ActivityID  uint16            `json:"activity_id"`
	TypeUID     uint32            `json:"type_uid"`
	SeverityID  uint8             `json:"severity_id"`
	Metadata    map[string]string `json:"metadata,omitempty"`
	Unmapped    map[string]string `json:"unmapped,omitempty"`
}

// collectSignalsForLatency reads every signal for this run's tenant from
// a fresh consumer group over `signals`, correlating each one carrying
// newInboxForwardingRuleID back to its own produce-time via EventIDs[0].
func collectSignalsForLatency(
	ctx context.Context, brokers, runID string, produceTimes *sync.Map,
	latenciesMu *sync.Mutex, latencies *[]float64, signalsReceived *atomic.Int64,
) {
	group := "loadtest-collect-" + runID
	client, err := kgo.NewClient(
		kgo.SeedBrokers(brokers),
		kgo.ConsumeTopics(sentinelstream.Signals),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
	)
	if err != nil {
		return
	}
	defer client.Close()

	for ctx.Err() == nil {
		pollCtx, cancel := context.WithTimeout(ctx, 1*time.Second)
		fetches := client.PollFetches(pollCtx)
		cancel()
		fetches.EachRecord(func(r *kgo.Record) {
			var sig sentinelsignal.Signal
			if err := json.Unmarshal(r.Value, &sig); err != nil {
				return
			}
			if sig.TenantID != runID || sig.RuleID != newInboxForwardingRuleID || len(sig.EventIDs) == 0 {
				return
			}
			raw, ok := produceTimes.LoadAndDelete(sig.EventIDs[0])
			if !ok {
				return
			}
			produceTime := raw.(time.Time)
			latencyMs := sig.DetectedAt.Sub(produceTime).Seconds() * 1000
			latenciesMu.Lock()
			*latencies = append(*latencies, latencyMs)
			latenciesMu.Unlock()
			signalsReceived.Add(1)
		})
	}
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(p * float64(len(sorted)-1))
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}
