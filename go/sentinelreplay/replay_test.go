package sentinelreplay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
)

// fakeRawArchiveReader is a test double for sentinelconnector.RawArchiveReader
// — an in-memory map of key -> object, with ListObjectKeys always
// returning every key regardless of the requested range (the range
// scoping itself is S3RawArchiveReader's own concern, already proven
// against real S3 in go/sentinelconnector's integration tests; this
// double exists to test Replayer's own orchestration logic in isolation).
type fakeRawArchiveReader struct {
	keys    []string
	objects map[string]sentinelconnector.RawArchiveObject
}

func (f *fakeRawArchiveReader) ListObjectKeys(context.Context, string, time.Time, time.Time) ([]string, error) {
	return append([]string(nil), f.keys...), nil
}

func (f *fakeRawArchiveReader) GetObject(_ context.Context, key string) (sentinelconnector.RawArchiveObject, error) {
	obj, ok := f.objects[key]
	if !ok {
		return sentinelconnector.RawArchiveObject{}, errors.New("fakeRawArchiveReader: no such object")
	}
	return obj, nil
}

// identityConnector's Normalise is deterministic given the same
// RawEvent, same reasoning as echoConnector in cmd/replay/main.go — the
// property these tests actually need from any connector they use.
type identityConnector struct{}

func (identityConnector) ID() sentinelconnector.ConnectorID { return "identity" }
func (identityConnector) Fetch(context.Context, sentinelconnector.Cursor) (sentinelconnector.Batch, sentinelconnector.Cursor, error) {
	return sentinelconnector.Batch{}, nil, errors.New("unused")
}
func (identityConnector) Normalise(raw sentinelconnector.RawEvent) ([]ocsf.Event, error) {
	// FetchedAt, not time.Now(): deterministic given the same RawEvent,
	// the exact property idempotent replay depends on (see Replayer's own
	// doc comment) — and NOT the zero value either, which found a real
	// gotcha the hard way: a zero TimeUnixMillis puts the row's `time`
	// column at the 1970 epoch, which is trivially older than
	// sentinel.events' 365-day TTL, so the row gets deleted by the very
	// next merge (including an explicit OPTIMIZE ... FINAL) almost as
	// soon as it's written — confirmed via ClickHouse's own query_log
	// showing a successful 40-row insert immediately followed by the
	// table reporting zero rows.
	//
	// event_id derived from a hash of the payload, not left unset: the
	// stored row's dedup key is (tenant_id, time, event_id)
	// (db/clickhouse/0001_events.sql) — every event in a test batch
	// shares the same tenant_id and (since FetchedAt is per-BATCH, not
	// per-event) the same time too, so an unset (empty-string) event_id
	// made every distinct seq value collide onto the SAME row instead of
	// 20 distinct ones — found the same way as the TTL issue above, via
	// a stored count of 1 instead of 20.
	sum := sha256.Sum256(raw.Payload)
	return []ocsf.Event{{
		TenantID:       raw.TenantID,
		TimeUnixMillis: raw.FetchedAt * 1000,
		Metadata:       map[string]string{"event_id": "identity-" + hex.EncodeToString(sum[:])},
		RawData:        raw.Payload,
	}}, nil
}
func (identityConnector) HealthCheck(context.Context) error { return nil }

const replayTestTenant = "tenant-replay-unit"

func newFakeArchive(n int) (*fakeRawArchiveReader, int) {
	reader := &fakeRawArchiveReader{objects: make(map[string]sentinelconnector.RawArchiveObject)}
	totalEvents := 0
	for i := 0; i < n; i++ {
		key := "raw/obj-" + string(rune('a'+i))
		events := []sentinelconnector.RawEvent{
			{TenantID: replayTestTenant, Payload: []byte(`{"n":` + string(rune('0'+i)) + `}`)},
		}
		reader.keys = append(reader.keys, key)
		reader.objects[key] = sentinelconnector.RawArchiveObject{TenantID: replayTestTenant, Events: events}
		totalEvents += len(events)
	}
	return reader, totalEvents
}

// T1 (unit half — the real-S3/real-Kafka half is replay_integration_test.go):
// every archived event is normalised and published exactly once.
func TestReplayPublishesNormalisedEventsForEveryArchivedEvent(t *testing.T) {
	reader, totalEvents := newFakeArchive(3)
	pub := sentinelconnector.NewInMemoryPublisher()
	checkpoints := NewInMemoryCheckpointStore()
	r := NewReplayer(reader, pub, checkpoints, nil)

	progress, err := r.Replay(context.Background(), "job-1", replayTestTenant, time.Now(), time.Now(), identityConnector{})
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if progress.ProcessedObjects != 3 || progress.TotalObjects != 3 {
		t.Fatalf("expected 3/3 objects processed, got %d/%d", progress.ProcessedObjects, progress.TotalObjects)
	}
	if published := pub.Published(replayTestTenant); len(published) != totalEvents {
		t.Fatalf("expected %d published events, got %d", totalEvents, len(published))
	}
}

// failAfterNPublisher fails every Publish call from the Nth call onward
// — simulates a replay job being interrupted partway through (AC4/T3),
// without needing a real process kill or context cancellation to prove
// the checkpoint/resume contract.
type failAfterNPublisher struct {
	inner    sentinelconnector.Publisher
	failFrom int
	calls    int
}

func (f *failAfterNPublisher) Publish(ctx context.Context, tenantID string, events []sentinelconnector.EventEnvelope) error {
	f.calls++
	if f.calls >= f.failFrom {
		return errors.New("failAfterNPublisher: simulated interruption")
	}
	return f.inner.Publish(ctx, tenantID, events)
}

// T3: an interrupted replay resumes from its checkpoint — nothing already
// published is re-published, and nothing is skipped either.
func TestReplayResumesFromCheckpointAfterInterruption(t *testing.T) {
	reader, totalEvents := newFakeArchive(5)
	checkpoints := NewInMemoryCheckpointStore()

	// First attempt: fails on the 3rd object's publish, simulating a crash
	// or a Ctrl-C partway through a 5-object job.
	innerPub1 := sentinelconnector.NewInMemoryPublisher()
	failingPub := &failAfterNPublisher{inner: innerPub1, failFrom: 3}
	r1 := NewReplayer(reader, failingPub, checkpoints, nil)

	progress1, err := r1.Replay(context.Background(), "job-resume", replayTestTenant, time.Now(), time.Now(), identityConnector{})
	if err == nil {
		t.Fatal("expected the first attempt to fail partway through")
	}
	if progress1.ProcessedObjects != 2 {
		t.Fatalf("expected exactly 2 objects checkpointed before the simulated failure, got %d", progress1.ProcessedObjects)
	}

	// Second attempt: SAME jobID (same checkpoint store), fresh publisher
	// that never fails — this is the "resume after a restart" path.
	innerPub2 := sentinelconnector.NewInMemoryPublisher()
	r2 := NewReplayer(reader, innerPub2, checkpoints, nil)

	progress2, err := r2.Replay(context.Background(), "job-resume", replayTestTenant, time.Now(), time.Now(), identityConnector{})
	if err != nil {
		t.Fatalf("expected the resumed attempt to complete, got: %v", err)
	}
	if progress2.ProcessedObjects != 5 {
		t.Fatalf("expected all 5 objects reflected as processed after resuming, got %d", progress2.ProcessedObjects)
	}

	// The resumed run's own publisher must have received ONLY the 3
	// objects the first run never got to — not the 2 it already
	// completed (no duplication) and not fewer (no gap).
	publishedByResume := innerPub2.Published(replayTestTenant)
	if len(publishedByResume) != totalEvents-2 {
		t.Fatalf("expected the resumed run to publish exactly the %d remaining events, got %d", totalEvents-2, len(publishedByResume))
	}

	// Across BOTH runs together, exactly totalEvents were published, once
	// each — the actual AC2 claim ("no observable duplication").
	totalPublished := len(innerPub1.Published(replayTestTenant)) + len(publishedByResume)
	if totalPublished != totalEvents {
		t.Fatalf("expected %d total events published across both attempts combined, got %d", totalEvents, totalPublished)
	}
}

// A third Replay call with the SAME jobID, after a full success, must be
// a complete no-op publish-wise — every key is already checkpointed. This
// is the "replay the same range twice" half of AC2, at the unit level.
func TestReplayingAnAlreadyCompletedJobPublishesNothingAgain(t *testing.T) {
	reader, _ := newFakeArchive(3)
	checkpoints := NewInMemoryCheckpointStore()

	pub1 := sentinelconnector.NewInMemoryPublisher()
	r1 := NewReplayer(reader, pub1, checkpoints, nil)
	if _, err := r1.Replay(context.Background(), "job-once", replayTestTenant, time.Now(), time.Now(), identityConnector{}); err != nil {
		t.Fatalf("first Replay: %v", err)
	}

	pub2 := sentinelconnector.NewInMemoryPublisher()
	r2 := NewReplayer(reader, pub2, checkpoints, nil)
	progress, err := r2.Replay(context.Background(), "job-once", replayTestTenant, time.Now(), time.Now(), identityConnector{})
	if err != nil {
		t.Fatalf("second Replay (same job id): %v", err)
	}
	if progress.ProcessedObjects != 3 {
		t.Fatalf("expected all 3 objects reported as processed, got %d", progress.ProcessedObjects)
	}
	if published := pub2.Published(replayTestTenant); len(published) != 0 {
		t.Fatalf("expected zero NEW publishes for an already-completed job, got %d", len(published))
	}
}
