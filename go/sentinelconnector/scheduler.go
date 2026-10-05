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
	// Quota is this tenant's rate limit (P1-10 AC1) — resolved from the
	// tenant's plan tier ONCE, at registration time by whoever composes the
	// scheduler (e.g. main.go, which has Postgres access to look up
	// tenants.plan), not looked up per-cycle. Keeps the scheduler's hot
	// path decoupled from the control-plane database entirely. Zero value
	// (both fields 0) means unlimited — RateLimiter.Allow with Burst=0,
	// EPS=0 would always grant 0, so the Scheduler treats an explicitly
	// zero Quota as "no limiter configured for this registration" rather
	// than "allow nothing", via the nil check on s.rateLimiter instead.
	Quota Quota
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

	// rateLimiter and archive are P1-10's addition. Both are nil-safe and
	// optional, same pattern as health/cycleCount above: a Scheduler built
	// without them (e.g. an existing test that predates this ticket)
	// behaves exactly as before — no limiting, no archiving. Only when
	// BOTH are set does runCycle apply AC1/AC3; a RateLimiter with no
	// ArchiveWriter would silently drop overflow, which AC3 forbids, so
	// NewScheduler requires them together (see below).
	rateLimiter RateLimiter
	archive     ArchiveWriter
	// quotaBreaches, if non-nil, counts cycles where a tenant's requested
	// volume exceeded what the limiter granted — AC4's "quota breaches
	// surfaced to tenant and ops" metric half; the tenant-facing half is
	// P1-11's dashboard, same deferral as cycleCount's own comment.
	quotaBreaches metric.Int64Counter

	mu           sync.Mutex
	registered   []TenantConnector
	cancelLoops  context.CancelFunc
	loopsRunning sync.WaitGroup
}

type SchedulerOptions struct {
	Interval      time.Duration
	Log           *slog.Logger
	CycleCount    metric.Int64Counter // optional
	Health        HealthRecorder      // optional — AC4's "surfaced" half; nil-safe, same as CycleCount
	RateLimiter   RateLimiter         // optional — P1-10 AC1/AC2; nil disables limiting entirely
	Archive       ArchiveWriter       // optional, but required alongside RateLimiter — see Scheduler's own doc comment
	QuotaBreaches metric.Int64Counter // optional
}

func NewScheduler(publisher Publisher, cursors CursorStorer, opts SchedulerOptions) *Scheduler {
	if opts.Interval <= 0 {
		opts.Interval = time.Minute
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	// A RateLimiter without an ArchiveWriter would mean overflow is simply
	// never published anywhere — silently violating AC3 ("never discarded")
	// the moment anyone sets one without the other. Failing fast here, at
	// construction, is cheaper than discovering it from a missing archive
	// object in production.
	if (opts.RateLimiter != nil) != (opts.Archive != nil) {
		panic("sentinelconnector: SchedulerOptions.RateLimiter and Archive must be set together or not at all")
	}
	return &Scheduler{
		publisher:     publisher,
		cursors:       cursors,
		health:        opts.Health,
		interval:      opts.Interval,
		log:           opts.Log,
		cycleCount:    opts.CycleCount,
		rateLimiter:   opts.RateLimiter,
		archive:       opts.Archive,
		quotaBreaches: opts.QuotaBreaches,
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

	// P1-10 AC1/AC2/AC3: rate-limit this tenant's batch before any of it is
	// normalised or published. allowedEvents is what proceeds through the
	// rest of this cycle exactly as before; the remainder (overflow) is
	// archived, never dropped and never published either — publishing a
	// RawEvent isn't possible, only a normalised one, so the split happens
	// here, on batch.Events, before Normalise even runs.
	allowedEvents := batch.Events
	if s.rateLimiter != nil && len(batch.Events) > 0 {
		granted, err := s.rateLimiter.Allow(ctx, tc.TenantID, tc.Quota, len(batch.Events))
		if err != nil {
			// RateLimiter implementations used in production wrap FailOpenLimiter,
			// which already falls back internally and does not return an error
			// for a down Redis — reaching here means something else is wrong
			// (e.g. a context deadline). Treat the whole batch as overflow rather
			// than either silently granting everything or dropping it.
			s.log.Error("rate limiter error, treating batch as overflow", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
			granted = 0
		}
		if granted < len(batch.Events) {
			overflow := batch.Events[granted:]
			allowedEvents = batch.Events[:granted]
			s.log.Warn("tenant exceeded quota, archiving overflow",
				"tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "stream", tc.Stream,
				"quota_eps", tc.Quota.EPS, "quota_burst", tc.Quota.Burst,
				"requested", len(batch.Events), "granted", granted, "overflow", len(overflow))
			if s.quotaBreaches != nil {
				s.quotaBreaches.Add(ctx, 1, metric.WithAttributes(
					attribute.String("tenant_id", tc.TenantID),
					attribute.String("connector_id", tc.ConnectorRowID),
					attribute.String("stream", tc.Stream),
				))
			}
			if s.archive != nil {
				if err := s.archive.Archive(ctx, tc.TenantID, tc.ConnectorRowID, overflow); err != nil {
					// AC3 ("never discarded") is violated if this archive write is
					// lost — failing the whole cycle (no cursor commit, no partial
					// publish of the allowed portion either) means next tick retries
					// the identical Fetch and gets another chance to archive it,
					// rather than quietly losing the overflow forever.
					s.log.Error("archiving overflow failed", "tenant_id", tc.TenantID, "connector_id", tc.ConnectorRowID, "err", err)
					return "archive_error"
				}
			}
		}
	}

	envelopes := make([]EventEnvelope, 0, len(allowedEvents))
	for _, raw := range allowedEvents {
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
