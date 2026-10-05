package sentinelconnector

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// TenantConnector is one registration: a connector instance running for one
// tenant against one logical stream (a connector can have more than one
// stream — e.g. M365's unified audit log vs its alerts feed — each with its
// own independent cursor).
type TenantConnector struct {
	TenantID       string
	ConnectorRowID string // connectors.id (UUID) — the tenant's specific connector instance row, NOT Connector.ID()'s kind string
	Stream         string
	Connector      Connector
}

// Scheduler runs every registered (tenant, connector, stream) on its own
// independent interval loop — deliberately one goroutine per registration,
// not a shared work queue, because a shared queue is exactly the design
// that would let one slow or wedged tenant delay every other tenant's
// schedule (P1-01 AC3/T3). Each loop's failure is contained to itself.
type Scheduler struct {
	publisher Publisher
	cursors   CursorStorer
	health    HealthRecorder
	interval  time.Duration
	log       *slog.Logger

	// cycleCount, if non-nil, is incremented once per completed cycle with
	// tenant_id/connector_id/stream/outcome attributes — the AC4 "health
	// exposed as a metric" requirement. Optional and nil-safe: P1-01 wires
	// the mechanism, P1-11 owns the full ingest-observability dashboard this
	// feeds.
	cycleCount metric.Int64Counter

	mu           sync.Mutex
	registered   []TenantConnector
	cancelLoops  context.CancelFunc
	loopsRunning sync.WaitGroup
}

type SchedulerOptions struct {
	Interval   time.Duration
	Log        *slog.Logger
	CycleCount metric.Int64Counter // optional
	Health     HealthRecorder      // optional — AC4's "surfaced" half; nil-safe, same as CycleCount
}

func NewScheduler(publisher Publisher, cursors CursorStorer, opts SchedulerOptions) *Scheduler {
	if opts.Interval <= 0 {
		opts.Interval = time.Minute
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	return &Scheduler{
		publisher:  publisher,
		cursors:    cursors,
		health:     opts.Health,
		interval:   opts.Interval,
		log:        opts.Log,
		cycleCount: opts.CycleCount,
	}
}

// Register adds a (tenant, connector, stream) to run once Start is called.
// Registering after Start has no effect on already-running loops — call
// Register for everything up front, matching how main() assembles a
// scheduler once at boot. Adding a brand new SOURCE never requires touching
// this type at all (AC1): it requires only a new Connector implementation
// and a Register call at the composition root.
func (s *Scheduler) Register(tc TenantConnector) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.registered = append(s.registered, tc)
}

// Start launches one loop per registration. ctx governs STARTING new
// cycles — cancelling it stops any loop from beginning its NEXT cycle, but
// deliberately does not reach into a cycle that is already running (see
// runLoop): that is what makes Shutdown a drain instead of an abort.
func (s *Scheduler) Start(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()

	loopCtx, cancel := context.WithCancel(ctx)
	s.cancelLoops = cancel

	for _, tc := range s.registered {
		s.loopsRunning.Add(1)
		go s.runLoop(loopCtx, tc)
	}
}

// Shutdown stops every loop from starting new cycles, then blocks until any
// cycle already in flight finishes naturally — AC5, "graceful shutdown
// drains in-flight batches before exiting." Returns early with ctx's error
// if the drain takes longer than the caller is willing to wait; callers
// that need a hard deadline should pass a context with a timeout, the same
// pattern services/ingest/cmd/ingest/main.go already uses for its HTTP
// server's own Shutdown.
func (s *Scheduler) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	cancel := s.cancelLoops
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}

	done := make(chan struct{})
	go func() {
		s.loopsRunning.Wait()
		close(done)
	}()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Scheduler) runLoop(ctx context.Context, tc TenantConnector) {
	defer s.loopsRunning.Done()

	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// A cycle that runs longer than the interval leaves ticker.C
			// with a tick already buffered by the time this loop comes back
			// around — so after a long cycle, ctx.Done() and ticker.C can
			// both be ready at once, and select picks between ready cases
			// pseudo-randomly rather than preferring Done(). Without this
			// recheck, that coin flip can start one more cycle AFTER
			// shutdown was already requested — caught by this package's own
			// test for exactly that (TestShutdownDrainsInFlightCycleWithout
			// StartingANewOne), which failed intermittently until this line
			// was added.
			if ctx.Err() != nil {
				return
			}
			// context.Background(), not ctx: a cycle that has already begun
			// (fetched a batch, maybe already published it) must run to
			// completion even if shutdown was requested mid-cycle — that is
			// the entire meaning of "drain" rather than "abort". ctx still
			// governs whether the NEXT tick is allowed to start a new one.
			s.runOnce(context.Background(), tc)
		}
	}
}

// runOnce executes exactly one fetch/normalise/publish/commit cycle for one
// registration. Panics from a misbehaving connector are recovered here
// specifically so one connector's bug cannot take down the loop running
// every OTHER tenant's connector in the same process (AC3) — a goroutine
// panic is otherwise fatal to the whole program, not just the one loop.
func (s *Scheduler) runOnce(ctx context.Context, tc TenantConnector) {
	defer func() {
		if r := recover(); r != nil {
			s.log.Error("connector cycle panicked",
				"tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "stream", tc.Stream, "panic", r)
			s.recordCycle(ctx, tc, "panic")
		}
	}()

	start := time.Now()
	outcome := s.runCycle(ctx, tc)
	s.log.Info("connector cycle finished",
		"tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "stream", tc.Stream,
		"outcome", outcome, "duration_ms", time.Since(start).Milliseconds())
	s.recordCycle(ctx, tc, outcome)
}

// runCycle is the actual ADR-0010 orchestration: fetch, normalise, publish,
// and only on a successful publish, commit the new cursor. Returns a short
// outcome string for logging/metrics, never an error — a failing cycle is
// not this loop's failure, it's next tick's retry.
func (s *Scheduler) runCycle(ctx context.Context, tc TenantConnector) string {
	cur, _, err := s.cursors.Get(ctx, tc.TenantID, tc.ConnectorRowID, tc.Stream)
	if err != nil {
		s.log.Error("reading cursor", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
		return "cursor_read_error"
	}

	batch, nextCur, err := tc.Connector.Fetch(ctx, cur)
	if err != nil {
		// T2: a connector error never advances the cursor — simply returning
		// here, before any cursor write, is the entire guarantee.
		s.log.Error("fetch failed", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
		return "fetch_error"
	}

	envelopes := make([]EventEnvelope, 0, len(batch.Events))
	for _, raw := range batch.Events {
		events, err := tc.Connector.Normalise(raw)
		if err != nil {
			s.log.Error("normalise failed", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
			return "normalise_error"
		}
		for _, ev := range events {
			payload, err := marshalEvent(ev)
			if err != nil {
				s.log.Error("marshalling event", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
				return "marshal_error"
			}
			envelopes = append(envelopes, EventEnvelope{TenantID: tc.TenantID, Payload: payload})
		}
	}

	if len(envelopes) > 0 {
		if err := s.publisher.Publish(ctx, tc.TenantID, envelopes); err != nil {
			// T1/T2: publish failed — the cursor must NOT advance. Returning
			// here before Commit is what makes that true.
			s.log.Error("publish failed", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
			return "publish_error"
		}
	}

	// Only reached after a successful publish (or an empty batch, which has
	// nothing to lose by advancing) — ADR-0010's commit ordering.
	if err := s.cursors.Commit(ctx, tc.TenantID, tc.ConnectorRowID, tc.Stream, nextCur); err != nil {
		s.log.Error("committing cursor", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
		return "cursor_commit_error"
	}
	return "success"
}

func (s *Scheduler) recordCycle(ctx context.Context, tc TenantConnector, outcome string) {
	if s.cycleCount != nil {
		s.cycleCount.Add(ctx, 1, metric.WithAttributes(
			attribute.String("tenant_id", tc.TenantID),
			attribute.String("connector_id", tc.ConnectorRowID),
			attribute.String("stream", tc.Stream),
			attribute.String("outcome", outcome),
		))
	}

	if s.health != nil {
		success := outcome == "success"
		errMsg := ""
		if !success {
			errMsg = outcome
		}
		if err := s.health.RecordOutcome(ctx, tc.TenantID, tc.ConnectorRowID, success, errMsg); err != nil {
			s.log.Error("recording connector health", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
		}
	}
}
