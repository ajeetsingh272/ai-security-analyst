// P7-04: activates the shard split P1-05 (this package's own TenantKey/
// TenantShardKey) and P3-10 (services/correlate's own window-merge
// readiness) built but never turned on. The gap, confirmed by reading
// the real code rather than assumed: RedpandaPublisher.Publish always
// calls TenantKey(tenantID) — shard 0, unconditionally — and nothing
// anywhere decides a tenant should ever get anything else. This file is
// that missing decision.
//
// Design, worked out before writing code:
//
//   - tenants.eps_quota (already in the schema since P0, never read by
//     any code until now) is the per-tenant threshold AC4 calls "a
//     configured EPS threshold" — editable by updating that one column,
//     with NO redeploy, matching the exact "read the control table fresh
//     per decision" pattern services/correlate/internal/cluster's own
//     markEscalatedIfPending already establishes for tenants.plan
//     (postgres_store.go). A short in-process cache (shardConfigTTL)
//     keeps that read off the hot publish path without reintroducing a
//     redeploy requirement — propagation is bounded by that TTL, not by
//     a rebuild.
//   - tenants.shard_count is the CURRENT, system-managed shard count —
//     this file writes it (asynchronously, never blocking Publish) when
//     its own decision changes it. The seed fixture that ships with
//     shard_count=4 for one tenant (db/postgres/seed/0001_two_tenants.sql)
//     is exactly the "already decided to be hot" starting state a T1/T4
//     test wants, not something this controller needs to reproduce from
//     scratch.
//   - Scale-up/down is deliberately hysteretic (different thresholds for
//     growing vs shrinking) so a tenant riding exactly at its quota
//     doesn't flap shard counts every few seconds — the same reason any
//     autoscaler uses separate scale-up/scale-down bands.
//   - AC5 ("sharded and unsharded tenants behave identically") falls out
//     of the design rather than needing its own code path: shardCount<=1
//     takes the IDENTICAL branch TenantKey(tenantID) itself would have
//     taken (ParseTenantShardKey already treats "no suffix" and "shard 0"
//     as the same value — key.go's own doc comment) — there is no
//
// /    separate "unsharded" mode to keep in sync with the sharded one.
//   - Per-event round-robin across the current shard count, not a hash
//     of something stable like event id: the whole point is spreading a
//     hot tenant's load across multiple partitions (so no single
//     partition, and therefore no single consumer-side worker instance,
//     absorbs all of it — the actual mechanism load-test.md's own
//     noisy-neighbor finding (#122) identifies), at the deliberate,
//     accepted cost of cross-shard ordering for that one tenant while
//     it's hot (ADR-0003's own risk table; P3-10's window-merge logic in
//     services/correlate compensates for this at the correlation layer,
//     which already clusters on tenant_id/entity/window, never on
//     partition order — nothing here needs to re-litigate that).
//   - Single-producer-process scope: this repo's own ingest service runs
//     as one process scheduling every tenant's connectors (confirmed by
//     reading services/ingest/cmd/ingest/main.go), so in-process shard
//     state with an async Postgres write-back is sufficient — there is
//     no second producer process whose view of "how many shards is this
//     tenant on" could disagree. A horizontally-scaled ingest fleet
//     would need a shared coordination point (Postgres-backed
//     claim/lease, or similar) this file deliberately does not build,
//     since it does not yet exist to coordinate.
package sentinelstream

import (
	"context"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// maxShardCount bounds the blast radius of a single runaway-hot
	// tenant — a hard ceiling, not itself configurable, so a
	// misconfigured or malicious EPS spike cannot claim an unbounded
	// slice of a topic's own partition space out from under every other
	// tenant.
	maxShardCount = 8

	// epsWindowSeconds is the sliding window this controller measures a
	// tenant's own publish rate over — long enough to smooth out a
	// single bursty second, short enough that AC4's "takes effect
	// without redeployment" is a real, felt latency (seconds), not a
	// nominal one.
	epsWindowSeconds = 10

	// shardConfigTTL bounds how stale a cached eps_quota/shard_count
	// read is allowed to be — the only reason tenants.eps_quota being
	// "configurable... without redeployment" doesn't mean a Postgres
	// round trip on every single published event.
	shardConfigTTL = 5 * time.Second

	// scaleUpHysteresis/scaleDownHysteresis are deliberately different
	// bands (grow eagerly on real pressure, shrink conservatively) so a
	// tenant riding near its own quota doesn't flap shard counts on
	// every measurement tick.
	scaleUpHysteresis   = 1.0 // grow once per-shard EPS would exceed quota
	scaleDownHysteresis = 0.4 // shrink only once comfortably under quota for one fewer shard
)

// epsWindow is a per-tenant sliding event counter — one bucket per
// second over the last epsWindowSeconds, the simplest correct structure
// for "how many events has this tenant published recently," with no
// goroutine of its own (every method is called under the owning
// tenantShardState's own mutex).
type epsWindow struct {
	buckets    [epsWindowSeconds]int64
	bucketSecs [epsWindowSeconds]int64
}

func (w *epsWindow) record(nowUnix int64) {
	idx := nowUnix % epsWindowSeconds
	if w.bucketSecs[idx] != nowUnix {
		w.buckets[idx] = 0
		w.bucketSecs[idx] = nowUnix
	}
	w.buckets[idx]++
}

func (w *epsWindow) eps(nowUnix int64) float64 {
	var total int64
	for i := range w.buckets {
		if nowUnix-w.bucketSecs[i] < epsWindowSeconds {
			total += w.buckets[i]
		}
	}
	return float64(total) / float64(epsWindowSeconds)
}

type tenantShardState struct {
	mu                sync.Mutex
	window            epsWindow
	currentShardCount int
	nextShard         int
	cachedEPSQuota    int
	configFetchedAt   time.Time
}

// ShardController is P7-04's own deliverable — the decision
// RedpandaPublisher.Publish was always missing. nowFunc/persist are
// overridable purely for deterministic unit tests (a real clock and a
// real async Postgres writer in production).
type ShardController struct {
	pool *pgxpool.Pool

	mu    sync.Mutex
	state map[string]*tenantShardState

	nowFunc func() time.Time
	// quotaFunc reads tenants.eps_quota fresh for one tenant — a field,
	// not a hardcoded call, purely so unit tests can exercise the
	// scale-up/down decision deterministically without a real Postgres
	// connection (set directly in a same-package test, the same
	// white-box seam go/sentinelconnector/aws's own injected `sleep`
	// field and m365's own `api.baseURL` override already use).
	// NewShardController sets this to the real fetchEPSQuota.
	quotaFunc func(ctx context.Context, tenantID string, fallback int) int

	// persistQueue is drained by one background goroutine — Publish's
	// own hot path only ever does a non-blocking send to it, so a slow
	// or unavailable Postgres never adds latency to publishing, only to
	// how quickly tenants.shard_count catches up with what this
	// controller already decided in memory.
	persistQueue chan shardPersist
	closeOnce    sync.Once
	closed       chan struct{}
}

type shardPersist struct {
	tenantID string
	shards   int
}

// NewShardController wires a live controller against the real tenants
// table. pool is the same superuser-authenticated pool every other
// platform-wide (not per-tenant-RLS-scoped) read in this codebase
// already uses for the tenants table itself (postgres_store.go's own
// markEscalatedIfPending reads tenants.plan the identical way, with no
// WithTenantContext wrapper — tenants is the table that DEFINES tenant
// scope, not one scoped BY it).
func NewShardController(pool *pgxpool.Pool) *ShardController {
	c := &ShardController{
		pool:         pool,
		state:        make(map[string]*tenantShardState),
		nowFunc:      time.Now,
		persistQueue: make(chan shardPersist, 256),
		closed:       make(chan struct{}),
	}
	c.quotaFunc = c.fetchEPSQuota
	go c.runPersistLoop()
	return c
}

// Close stops the background persistence goroutine — production code
// should call this during graceful shutdown, mirroring every other
// long-lived component in this service's own shutdown sequence
// (main.go's signal.NotifyContext-driven drain).
func (c *ShardController) Close() {
	c.closeOnce.Do(func() { close(c.closed) })
}

// StateSnapshot returns the current in-memory shard count for one
// tenant — observability only (a dashboard, a test assertion); never
// call this from a hot path, it exists for callers outside this
// package that can't reach KeyFor's own private state directly.
func (c *ShardController) StateSnapshot(tenantID string) int {
	s := c.stateFor(tenantID)
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.currentShardCount
}

func (c *ShardController) runPersistLoop() {
	for {
		select {
		case p := <-c.persistQueue:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_, _ = c.pool.Exec(ctx, `UPDATE tenants SET shard_count = $1 WHERE id = $2`, p.shards, p.tenantID)
			cancel()
		case <-c.closed:
			return
		}
	}
}

func (c *ShardController) stateFor(tenantID string) *tenantShardState {
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.state[tenantID]
	if !ok {
		s = &tenantShardState{currentShardCount: 1}
		c.state[tenantID] = s
	}
	return s
}

// KeyFor is this controller's one real entry point — called from
// RedpandaPublisher.Publish's own hot path once per publish batch.
// Returns exactly TenantKey(tenantID) (shard 0) for any tenant this
// controller has never decided to shard, so AC5's "behave identically"
// is the DEFAULT, not a special case this function has to detect.
func (c *ShardController) KeyFor(ctx context.Context, tenantID string) string {
	s := c.stateFor(tenantID)

	s.mu.Lock()
	defer s.mu.Unlock()

	now := c.nowFunc()
	nowUnix := now.Unix()
	s.window.record(nowUnix)

	if now.Sub(s.configFetchedAt) > shardConfigTTL {
		s.cachedEPSQuota = c.quotaFunc(ctx, tenantID, s.cachedEPSQuota)
		s.configFetchedAt = now
	}

	c.reviseShardCount(s, tenantID, nowUnix)

	if s.currentShardCount <= 1 {
		return TenantKey(tenantID)
	}
	shard := s.nextShard % s.currentShardCount
	s.nextShard++
	return TenantShardKey(tenantID, shard)
}

// fetchEPSQuota reads tenants.eps_quota fresh — a cache MISS (not a
// background poll loop) is what keeps this off the hot path by default
// while still reading real, current configuration at least once per
// shardConfigTTL window. A transient read failure keeps the LAST known
// value rather than falling back to some hardcoded default, so a
// momentary Postgres blip can never cause an already-sharded tenant to
// look unsharded.
func (c *ShardController) fetchEPSQuota(ctx context.Context, tenantID string, fallback int) int {
	var quota int
	if err := c.pool.QueryRow(ctx, `SELECT eps_quota FROM tenants WHERE id = $1`, tenantID).Scan(&quota); err != nil {
		return fallback
	}
	return quota
}

// reviseShardCount is AC1/T4's own decision: scale up when this
// tenant's measured per-shard load would exceed its quota, scale down
// (never below 1 — the identical floor TenantKey's own default already
// is) once comfortably under quota for one fewer shard. Both directions
// are bounded by maxShardCount and floor 1 — this function can never
// produce a value outside [1, maxShardCount].
func (c *ShardController) reviseShardCount(s *tenantShardState, tenantID string, nowUnix int64) {
	if s.cachedEPSQuota <= 0 {
		return // no real quota configured yet (or Postgres unreachable on this tenant's first-ever read) — never shard on an unknown threshold
	}
	eps := s.window.eps(nowUnix)

	for s.currentShardCount < maxShardCount && eps > float64(s.cachedEPSQuota)*float64(s.currentShardCount)*scaleUpHysteresis {
		s.currentShardCount++
		c.enqueuePersist(tenantID, s.currentShardCount)
	}
	for s.currentShardCount > 1 && eps < float64(s.cachedEPSQuota)*float64(s.currentShardCount-1)*scaleDownHysteresis {
		s.currentShardCount--
		c.enqueuePersist(tenantID, s.currentShardCount)
	}
}

func (c *ShardController) enqueuePersist(tenantID string, shards int) {
	select {
	case c.persistQueue <- shardPersist{tenantID: tenantID, shards: shards}:
	default:
		// Queue is full — an observability lag, never a correctness
		// problem: this controller's own in-memory currentShardCount
		// (what KeyFor actually routes on) is already correct regardless
		// of whether tenants.shard_count has caught up yet.
	}
}
