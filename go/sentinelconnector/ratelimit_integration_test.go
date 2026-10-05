//go:build integration

package sentinelconnector

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
	"github.com/redis/go-redis/v9"
)

// newTestRedisClient points at the dev stack's real Redis-protocol-compatible
// server (infra/docker/docker-compose.dev.yml's `redis` service, actually
// valkey, plain TCP, no auth, localhost:6379) — same skip-cleanly-if-down
// convention go/sentineldb/tenant_integration_test.go already established
// for Postgres, so `go test -tags=integration` fails usefully instead of
// hanging when `pnpm dev:stack` isn't running.
func newTestRedisClient(t *testing.T) *redis.Client {
	t.Helper()
	client := redis.NewClient(&redis.Options{Addr: "localhost:6379"})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		t.Skipf("Redis not reachable (pnpm dev:stack running?): %v", err)
	}
	return client
}

// repoRoot walks up from this test file's own path rather than assuming the
// test runner's working directory — scripts/go-test-integration.sh already
// cd's into go/sentinelconnector before running `go test`, so "." is NOT the
// repo root by the time this runs.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("determining repo root via runtime.Caller")
	}
	return filepath.Join(filepath.Dir(file), "..", "..")
}

func dockerComposeRedis(t *testing.T, action string) {
	t.Helper()
	cmd := exec.Command("docker", "compose", "-f", "infra/docker/docker-compose.dev.yml", action, "redis")
	cmd.Dir = repoRoot(t)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("docker compose %s redis: %v\n%s", action, err, out)
	}
}

// safeUnpauseRedis is the T3 cleanup: always run (via defer), tolerant of
// redis already being unpaused — e.g. the test's own explicit unpause step
// already succeeded and this is just belt-and-suspenders in case an
// assertion failed first and skipped past it.
func safeUnpauseRedis(t *testing.T) {
	t.Helper()
	cmd := exec.Command("docker", "compose", "-f", "infra/docker/docker-compose.dev.yml", "unpause", "redis")
	cmd.Dir = repoRoot(t)
	out, err := cmd.CombinedOutput()
	if err != nil && !strings.Contains(strings.ToLower(string(out)), "not paused") {
		t.Logf("cleanup: unpause redis: %v\n%s", err, out)
	}
}

// archiveRecorder is a test-only ArchiveWriter: records how many overflow
// events were archived per tenant, without needing a real S3 endpoint —
// what T1/T3 actually exercise is the REAL shared Redis rate limiter's
// per-tenant isolation and fail-open behaviour; S3ArchiveWriter's own
// write path has no tenant-isolation properties to prove and would only add
// an unrelated dependency to these tests.
type archiveRecorder struct {
	mu     sync.Mutex
	counts map[string]int
}

func newArchiveRecorder() *archiveRecorder {
	return &archiveRecorder{counts: make(map[string]int)}
}

func (a *archiveRecorder) Archive(_ context.Context, tenantID, _ string, events []RawEvent) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.counts[tenantID] += len(events)
	return nil
}

func (a *archiveRecorder) count(tenantID string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.counts[tenantID]
}

// batchConnector is like scheduler_test.go's fakeConnector but returns a
// fixed-size batch of n synthetic events on every Fetch call, forever —
// what T1 needs to simulate one tenant sustaining a steady request rate and
// another hammering at many times that rate, cycle after cycle.
type batchConnector struct {
	id         ConnectorID
	tenantID   string
	n          int
	fetchCalls atomic.Int32
}

func (c *batchConnector) ID() ConnectorID { return c.id }

func (c *batchConnector) Fetch(_ context.Context, _ Cursor) (Batch, Cursor, error) {
	call := c.fetchCalls.Add(1)
	events := make([]RawEvent, c.n)
	for i := range events {
		events[i] = RawEvent{TenantID: c.tenantID, Payload: []byte(`{"x":1}`)}
	}
	return Batch{Events: events}, Cursor(fmt.Sprintf(`{"page":%d}`, call)), nil
}

func (c *batchConnector) Normalise(raw RawEvent) ([]ocsf.Event, error) {
	return []ocsf.Event{{TenantID: raw.TenantID, RawData: raw.Payload}}, nil
}

func (c *batchConnector) HealthCheck(context.Context) error { return nil }

// T1: a tenant emitting far more than its quota (the "noisy neighbour")
// must not reduce how much of a well-behaved tenant's traffic gets through,
// against a REAL shared Redis-backed token bucket — not just the in-process
// isolation scheduler_concurrency_test.go already proves via one goroutine
// per tenant, but isolation of the rate limiter's own shared backing store.
func TestNoisyNeighborDoesNotStarveOtherTenant(t *testing.T) {
	client := newTestRedisClient(t)
	defer client.Close()

	suffix := time.Now().UnixNano()
	quietTenant := fmt.Sprintf("tenant-quiet-%d", suffix)
	noisyTenant := fmt.Sprintf("tenant-noisy-%d", suffix)

	// EPS=50/Burst=50, 100ms tick => 5 tokens refilled per cycle. The quiet
	// tenant requests exactly 5 per cycle — sustainable forever. The noisy
	// tenant requests 50x that (250/cycle) — the burst covers the first
	// cycle, then it is throttled down to the same steady 5/cycle refill.
	quota := Quota{EPS: 50, Burst: 50}

	pub := NewInMemoryPublisher()
	cursors := NewInMemoryCursorStore()
	archive := newArchiveRecorder()

	s := NewScheduler(pub, cursors, SchedulerOptions{
		Interval:    100 * time.Millisecond,
		Log:         slog.Default(),
		RateLimiter: NewRedisTokenBucket(client),
		Archive:     archive,
	})

	quietConn := &batchConnector{id: "quiet", tenantID: quietTenant, n: 5}
	noisyConn := &batchConnector{id: "noisy", tenantID: noisyTenant, n: 250}
	s.Register(TenantConnector{TenantID: quietTenant, ConnectorRowID: "conn-quiet", Stream: "main", Connector: quietConn, Quota: quota})
	s.Register(TenantConnector{TenantID: noisyTenant, ConnectorRowID: "conn-noisy", Stream: "main", Connector: noisyConn, Quota: quota})

	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	time.Sleep(650 * time.Millisecond) // ~6 ticks
	cancel()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := s.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	quietFetches := int(quietConn.fetchCalls.Load())
	quietPublished := len(pub.Published(quietTenant))
	if quietFetches == 0 {
		t.Fatal("expected the quiet tenant's connector to have run at least once")
	}
	wantQuiet := quietFetches * 5
	if quietPublished != wantQuiet {
		t.Fatalf("quiet tenant throttled by the noisy neighbour: expected all %d requested events granted (fetches=%d), got %d published",
			wantQuiet, quietFetches, quietPublished)
	}
	if got := archive.count(quietTenant); got != 0 {
		t.Fatalf("expected the quiet tenant to have zero archived overflow, got %d", got)
	}

	noisyFetches := int(noisyConn.fetchCalls.Load())
	noisyPublished := len(pub.Published(noisyTenant))
	noisyArchived := archive.count(noisyTenant)
	wantNoisyRequested := noisyFetches * 250
	if noisyPublished+noisyArchived != wantNoisyRequested {
		t.Fatalf("AC3 violated: noisy tenant's events neither published nor archived — requested=%d published=%d archived=%d",
			wantNoisyRequested, noisyPublished, noisyArchived)
	}
	// The noisy tenant must have been meaningfully throttled — it is
	// requesting 50x the quiet tenant's rate, so if it were never archived
	// at all the rate limiter isn't doing anything.
	if noisyArchived == 0 {
		t.Fatal("expected the noisy tenant to have overflow archived — it requested 50x its configured quota")
	}
	// And the quiet tenant's full grant, proven above, is the actual
	// isolation property: the noisy tenant's overconsumption must not have
	// borrowed from or blocked the quiet tenant's separate bucket.
}

// T3: a Redis outage must degrade rate limiting to FallbackQuota rather
// than halting ingest (AC5) — proven against a REAL redis container that
// this test actually pauses, the same docker-compose-pause pattern this
// session's earlier Kafka/ClickHouse outage tests established, not a
// mocked error.
func TestRedisOutageDegradesToFallbackQuotaWithoutHaltingIngest(t *testing.T) {
	client := newTestRedisClient(t)
	defer client.Close()

	var failOpenCalls atomic.Int32
	limiter := NewFailOpenLimiter(NewRedisTokenBucket(client), func(string, error) {
		failOpenCalls.Add(1)
	})

	tenantID := fmt.Sprintf("tenant-outage-%d", time.Now().UnixNano())
	// A plan tier far above FallbackQuota — if Redis being down caused this
	// tenant's REAL quota to be honoured instead of the conservative
	// fallback, this test would not catch it unless the two are clearly
	// different scales.
	highQuota := DefaultQuotas["msp"] // EPS=2000, Burst=4000

	// Sanity check while Redis is healthy: the real quota is honoured.
	granted, err := limiter.Allow(context.Background(), tenantID, highQuota, 500)
	if err != nil {
		t.Fatalf("Allow (redis healthy): %v", err)
	}
	if granted != 500 {
		t.Fatalf("expected the full request granted while redis is healthy, got %d", granted)
	}
	if failOpenCalls.Load() != 0 {
		t.Fatalf("did not expect onFailOpen to fire while redis is healthy")
	}

	dockerComposeRedis(t, "pause")
	defer safeUnpauseRedis(t)

	granted, err = limiter.Allow(context.Background(), tenantID, highQuota, 5000)
	if err != nil {
		// AC5's entire point: ingest must not halt (return an error that
		// would stop the scheduler's cycle) just because Redis is down.
		t.Fatalf("Allow must not error while redis is down (AC5 fail-open), got: %v", err)
	}
	if granted == 0 {
		t.Fatal("expected some tokens granted from the degraded fallback bucket, got 0")
	}
	if granted > FallbackQuota.Burst {
		t.Fatalf("expected the degraded grant capped at the conservative FallbackQuota.Burst=%d, got %d — "+
			"this would mean the tenant's real (much larger) quota leaked through during the outage",
			FallbackQuota.Burst, granted)
	}
	if failOpenCalls.Load() == 0 {
		t.Fatal("expected onFailOpen to have fired at least once while redis was down")
	}

	dockerComposeRedis(t, "unpause")

	// Confirm recovery: Redis healthy again means the real (high) quota is
	// honoured once more, not stuck on the degraded fallback forever.
	deadline := time.Now().Add(5 * time.Second)
	var recoveredGrant int
	var lastErr error
	for time.Now().Before(deadline) {
		recoveredGrant, lastErr = limiter.Allow(context.Background(), tenantID+"-recovered", highQuota, 500)
		if lastErr == nil && recoveredGrant == 500 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if lastErr != nil || recoveredGrant != 500 {
		t.Fatalf("expected full quota honoured again after redis recovered, got granted=%d err=%v", recoveredGrant, lastErr)
	}
}
