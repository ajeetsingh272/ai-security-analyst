package sentinelconnector

import (
	"context"
	"errors"
	"fmt"
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

// registrationKey is the composite key this package consistently uses to
// identify one (tenant, connector, stream) registration — same convention
// InMemoryCursorStore already established.
func registrationKey(tc TenantConnector) string {
	return tc.TenantID + "/" + tc.ConnectorRowID + "/" + tc.Stream
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
	// exposed as a metric" requirement (P1-01), and also this package's own
	// per-connector error-rate signal (P1-11 AC2: rate(cycleCount{outcome!=
	// "success"}) / rate(cycleCount) needs no separate metric).
	cycleCount metric.Int64Counter

	// P1-11's additions below. All optional and nil-safe, same pattern as
	// cycleCount/health: a Scheduler built without them behaves exactly as
	// P1-01 left it.
	//
	// ingestLag is a gauge of seconds since this (tenant, connector)'s last
	// successful cycle (or since registration, if it has never had one —
	// see computeLag), recorded periodically by runLagReporter rather than
	// only inside runCycle, so the value is correct even while a stalled
	// connector's loop isn't completing any cycles at all to update it.
	ingestLag metric.Int64Gauge
	// eventsPublished and batchSize are AC2's "EPS... and batch size...
	// exported per connector" — rate(eventsPublished) over time is EPS; a
	// separate metric for EPS itself would just be a derived view of the
	// same counter, so none is added.
	eventsPublished   metric.Int64Counter
	batchSize         metric.Int64Histogram
	lagReportInterval time.Duration

	// lastSuccess and registeredAt back computeLag: lastSuccess only has an
	// entry once a registration has completed at least one successful
	// cycle; until then, lag is measured from registeredAt instead (T2).
	lastSuccess  sync.Map // registrationKey -> time.Time
	registeredAt sync.Map // registrationKey -> time.Time

	// now, not time.Now directly, so tests can prove the lag calculation
	// and the reporting loop without a real wall-clock wait — same
	// clock-injection reasoning as go/sentinelevents/batch.go's
	// newBatchWithClock.
	now func() time.Time

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

	IngestLag         metric.Int64Gauge   // optional — P1-11 AC1
	EventsPublished   metric.Int64Counter // optional — P1-11 AC2
	BatchSize         metric.Int64Histogram
	LagReportInterval time.Duration // optional, defaults to 10s
}

func NewScheduler(publisher Publisher, cursors CursorStorer, opts SchedulerOptions) *Scheduler {
	if opts.Interval <= 0 {
		opts.Interval = time.Minute
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.LagReportInterval <= 0 {
		opts.LagReportInterval = 10 * time.Second
	}
	return &Scheduler{
		publisher:         publisher,
		cursors:           cursors,
		health:            opts.Health,
		interval:          opts.Interval,
		log:               opts.Log,
		cycleCount:        opts.CycleCount,
		ingestLag:         opts.IngestLag,
		eventsPublished:   opts.EventsPublished,
		batchSize:         opts.BatchSize,
		lagReportInterval: opts.LagReportInterval,
		now:               time.Now,
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
	// Recorded even if Start is never called or this registration never
	// runs a cycle — T2's scenario needs a baseline that exists from the
	// moment a connector is known about, not from its first (possibly
	// never-arriving) successful cycle.
	s.registeredAt.Store(registrationKey(tc), s.now())
}

// Start launches one loop per registration, plus one additional loop that
// periodically reports ingest lag for every registration (P1-11) — kept
// separate from runLoop/runOnce because lag must still be reported for a
// connector that is NOT completing cycles at all, which is exactly the
// stalled case this metric exists to catch. ctx governs STARTING new
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

	s.loopsRunning.Add(1)
	go s.runLagReporter(loopCtx)
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

// runLagReporter periodically records every registration's current ingest
// lag, independently of whether that registration's own loop is completing
// cycles — a connector stuck forever in Fetch never reaches recordCycle
// again, so lag cannot be (only) updated from there.
func (s *Scheduler) runLagReporter(ctx context.Context) {
	defer s.loopsRunning.Done()

	if s.ingestLag == nil {
		// Nothing to report; still consume ctx.Done() so Start/Shutdown's
		// bookkeeping (loopsRunning) stays correct even with no metric wired.
		<-ctx.Done()
		return
	}

	ticker := time.NewTicker(s.lagReportInterval)
	defer ticker.Stop()

	s.reportLag(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.reportLag(ctx)
		}
	}
}

func (s *Scheduler) reportLag(ctx context.Context) {
	s.mu.Lock()
	regs := make([]TenantConnector, len(s.registered))
	copy(regs, s.registered)
	s.mu.Unlock()

	now := s.now()
	for _, tc := range regs {
		lag := s.lagFor(tc, now)
		s.ingestLag.Record(ctx, int64(lag.Seconds()), metric.WithAttributes(
			attribute.String("tenant_id", tc.TenantID),
			attribute.String("connector_id", tc.ConnectorRowID),
			attribute.String("stream", tc.Stream),
		))
	}
}

func (s *Scheduler) lagFor(tc TenantConnector, now time.Time) time.Duration {
	key := registrationKey(tc)
	if v, ok := s.lastSuccess.Load(key); ok {
		return computeLag(now, time.Time{}, v.(time.Time), true)
	}
	registeredAt, _ := s.registeredAt.Load(key)
	rt, _ := registeredAt.(time.Time)
	return computeLag(now, rt, time.Time{}, false)
}

// computeLag is the pure calculation P1-11 T2 proves directly: how long it
// has been since this registration last completed successfully. A
// connector that has never succeeded even once (hasSucceeded=false) still
// produces a real, growing duration — measured from registeredAt — rather
// than zero, which would hide a connector that has never worked at all
// behind what looks like a perfectly healthy "no lag" reading.
func computeLag(now, registeredAt, lastSuccess time.Time, hasSucceeded bool) time.Duration {
	if hasSucceeded {
		return now.Sub(lastSuccess)
	}
	return now.Sub(registeredAt)
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
			s.recordCycle(ctx, tc, "panic", fmt.Errorf("panic: %v", r))
		}
	}()

	start := time.Now()
	outcome, err := s.runCycle(ctx, tc)
	s.log.Info("connector cycle finished",
		"tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "stream", tc.Stream,
		"outcome", outcome, "duration_ms", time.Since(start).Milliseconds())
	s.recordCycle(ctx, tc, outcome, err)
}

// runCycle is the actual ADR-0010 orchestration: fetch, normalise, publish,
// and only on a successful publish, commit the new cursor. Returns a short
// outcome string for logging/metrics plus the underlying error (nil on
// success) so recordCycle can map it to a connectors.status value — never
// returns an error to its OWN caller, since a failing cycle is not this
// loop's failure, it's next tick's retry.
func (s *Scheduler) runCycle(ctx context.Context, tc TenantConnector) (string, error) {
	cur, _, err := s.cursors.Get(ctx, tc.TenantID, tc.ConnectorRowID, tc.Stream)
	if err != nil {
		s.log.Error("reading cursor", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
		return "cursor_read_error", err
	}

	batch, nextCur, err := tc.Connector.Fetch(ctx, cur)
	if err != nil {
		// T2: a connector error never advances the cursor — simply returning
		// here, before any cursor write, is the entire guarantee.
		s.log.Error("fetch failed", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
		return "fetch_error", err
	}

	if s.batchSize != nil {
		s.batchSize.Record(ctx, int64(len(batch.Events)), metric.WithAttributes(
			attribute.String("tenant_id", tc.TenantID),
			attribute.String("connector_id", tc.ConnectorRowID),
			attribute.String("stream", tc.Stream),
		))
	}

	envelopes := make([]EventEnvelope, 0, len(batch.Events))
	for _, raw := range batch.Events {
		events, err := tc.Connector.Normalise(raw)
		if err != nil {
			s.log.Error("normalise failed", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
			return "normalise_error", err
		}
		for _, ev := range events {
			payload, err := marshalEvent(ev)
			if err != nil {
				s.log.Error("marshalling event", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
				return "marshal_error", err
			}
			envelopes = append(envelopes, EventEnvelope{TenantID: tc.TenantID, Payload: payload})
		}
	}

	if len(envelopes) > 0 {
		if err := s.publisher.Publish(ctx, tc.TenantID, envelopes); err != nil {
			// T1/T2: publish failed — the cursor must NOT advance. Returning
			// here before Commit is what makes that true.
			s.log.Error("publish failed", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
			return "publish_error", err
		}
		if s.eventsPublished != nil {
			s.eventsPublished.Add(ctx, int64(len(envelopes)), metric.WithAttributes(
				attribute.String("tenant_id", tc.TenantID),
				attribute.String("connector_id", tc.ConnectorRowID),
				attribute.String("stream", tc.Stream),
			))
		}
	}

	// Only reached after a successful publish (or an empty batch, which has
	// nothing to lose by advancing) — ADR-0010's commit ordering.
	if err := s.cursors.Commit(ctx, tc.TenantID, tc.ConnectorRowID, tc.Stream, nextCur); err != nil {
		s.log.Error("committing cursor", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
		return "cursor_commit_error", err
	}
	return "success", nil
}

// healthStatusFor maps a cycle's outcome error onto the connectors table's
// own status vocabulary — ErrConsentRevoked specifically becomes "revoked"
// rather than the generic "degraded" every other failure maps to, so the
// health endpoint (P1-11 T3) can tell "needs the tenant to re-authorise"
// apart from an ordinary transient failure. "degraded", not "error", for
// the generic case: docs/architecture/overview.md's own failure-mode table
// frames a struggling connector as "degraded in UI", not "error" — this
// package never writes "error" or "pending" itself.
func healthStatusFor(err error) string {
	if err == nil {
		return "healthy"
	}
	if errors.Is(err, ErrConsentRevoked) {
		return "revoked"
	}
	return "degraded"
}

func (s *Scheduler) recordCycle(ctx context.Context, tc TenantConnector, outcome string, cycleErr error) {
	if s.cycleCount != nil {
		s.cycleCount.Add(ctx, 1, metric.WithAttributes(
			attribute.String("tenant_id", tc.TenantID),
			attribute.String("connector_id", tc.ConnectorRowID),
			attribute.String("stream", tc.Stream),
			attribute.String("outcome", outcome),
		))
	}

	if cycleErr == nil {
		s.lastSuccess.Store(registrationKey(tc), s.now())
	}

	if s.health != nil {
		status := healthStatusFor(cycleErr)
		errMsg := ""
		if cycleErr != nil {
			errMsg = cycleErr.Error()
		}
		if err := s.health.RecordOutcome(ctx, tc.TenantID, tc.ConnectorRowID, status, errMsg); err != nil {
			s.log.Error("recording connector health", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
		}
	}
}
