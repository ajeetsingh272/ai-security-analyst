//go:build integration

package sentinelreplay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelevents"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
)

// provisionTopic creates an ad hoc, per-test-run output topic — the real
// CLI tool provisions this via sentinelstream.Provisioner.Apply too, but
// that only knows about MainTopics; a fresh, uniquely-named replay topic
// per test run needs its own idempotent create here.
func provisionTopic(t *testing.T, client *kgo.Client, topic string) {
	t.Helper()
	admin := kadm.NewClient(client)
	_, err := admin.CreateTopic(context.Background(), 4, 1, nil, topic)
	if err != nil && !errors.Is(err, kerr.TopicAlreadyExists) {
		t.Fatalf("provisioning topic %s: %v", topic, err)
	}
}

func chConnect(t *testing.T) (clickhouse.Conn, error) {
	t.Helper()
	return clickhouse.Open(&clickhouse.Options{Addr: []string{"localhost:9000"}, Auth: clickhouse.Auth{Database: "sentinel", Username: "default"}})
}

func newTestS3Client(t *testing.T) *s3.Client {
	t.Helper()
	client := s3.New(s3.Options{
		Region:       "ap-south-1",
		Credentials:  credentials.NewStaticCredentialsProvider("sentineldev", "sentineldev", ""),
		BaseEndpoint: aws.String("http://localhost:8333"),
		UsePathStyle: true,
	})
	if _, err := client.ListBuckets(context.Background(), &s3.ListBucketsInput{}); err != nil {
		t.Skipf("S3 (SeaweedFS) not reachable (pnpm dev:stack running?): %v", err)
	}
	return client
}

func newTestKafkaClient(t *testing.T, opts ...kgo.Opt) *kgo.Client {
	t.Helper()
	client, err := kgo.NewClient(append([]kgo.Opt{kgo.SeedBrokers("localhost:19092")}, opts...)...)
	if err != nil {
		t.Fatalf("creating kafka client: %v", err)
	}
	if err := client.Ping(context.Background()); err != nil {
		client.Close()
		t.Skipf("Redpanda not reachable (pnpm dev:stack running?): %v", err)
	}
	return client
}

// archiveSyntheticRaw writes n raw events straight into the real S3
// archive for tenantID/day, bypassing the connector scheduler entirely —
// this test is about REPLAY, not re-proving P1-08's own archive-write
// path (already covered by go/sentinelconnector's own tests).
func archiveSyntheticRaw(t *testing.T, writer *sentinelconnector.S3RawArchiveWriter, tenantID string, day time.Time, n int, seqOffset int) {
	t.Helper()
	events := make([]sentinelconnector.RawEvent, n)
	for i := 0; i < n; i++ {
		events[i] = sentinelconnector.RawEvent{
			TenantID: tenantID,
			Payload:  []byte(fmt.Sprintf(`{"seq":%d}`, seqOffset+i)),
			// A real FetchedAt, not the zero value: identityConnector
			// derives the normalised event's own TimeUnixMillis from
			// this, and a zero timestamp puts the stored row's `time` at
			// the 1970 epoch — trivially older than sentinel.events' own
			// 365-day TTL, so the row gets deleted by the very next
			// merge (including an explicit OPTIMIZE ... FINAL) almost
			// immediately after being written. See identityConnector's
			// own doc comment for how this was actually found.
			FetchedAt: day.Unix(),
		}
	}
	if err := writer.ArchiveRaw(context.Background(), tenantID, "conn-replay-it", day, events); err != nil {
		t.Fatalf("archiving synthetic raw events: %v", err)
	}
}

// runBridgeOnce drains whatever is currently available on the replay
// output topic and republishes it to events.normalized, exactly the same
// test-only stand-in for P1-04's not-yet-built normaliser go/soaktest's
// own bridge uses — duplicated here deliberately rather than imported,
// since go/soaktest is a `package main`, not an importable library.
func runBridgeOnce(ctx context.Context, consumeClient, produceClient *kgo.Client, outputTopic string) (int, error) {
	fetches := consumeClient.PollFetches(ctx)
	if errs := fetches.Errors(); len(errs) > 0 {
		for _, e := range errs {
			if e.Err != nil && !errors.Is(e.Err, context.DeadlineExceeded) && !errors.Is(e.Err, context.Canceled) {
				return 0, fmt.Errorf("bridge: fetch error: %w", e.Err)
			}
		}
	}

	var records []*kgo.Record
	var bridgeErr error
	fetches.EachRecord(func(rec *kgo.Record) {
		var ev ocsf.Event
		if err := json.Unmarshal(rec.Value, &ev); err != nil {
			bridgeErr = fmt.Errorf("bridge: unmarshalling replayed event: %w", err)
			return
		}
		row := sentinelevents.EventRow{
			TenantID: ev.TenantID,
			EventID:  ev.Metadata["event_id"],
			Time:     time.UnixMilli(ev.TimeUnixMillis),
			Message:  "replay test event",
		}
		payload, err := json.Marshal(row)
		if err != nil {
			bridgeErr = fmt.Errorf("bridge: marshalling event row: %w", err)
			return
		}
		records = append(records, &kgo.Record{Topic: sentinelstream.EventsNormalized, Key: []byte(ev.TenantID + ":0"), Value: payload})
	})
	if bridgeErr != nil {
		return 0, bridgeErr
	}
	if len(records) == 0 {
		return 0, nil
	}
	for _, res := range produceClient.ProduceSync(ctx, records...) {
		if res.Err != nil {
			return 0, fmt.Errorf("bridge: producing to events.normalized: %w", res.Err)
		}
	}
	return len(records), nil
}

// T1: replay of a known range reproduces the identical normalised event
// set — proven against the real S3 archive and real Kafka output topic,
// not a fake.
func TestReplayPublishesIdenticalNormalisedEventSetAgainstRealInfra(t *testing.T) {
	s3Client := newTestS3Client(t)
	tenantID := fmt.Sprintf("70000000-0000-4000-8000-%012d", time.Now().UnixNano()%1_000_000_000_000)
	outputTopic := fmt.Sprintf("events.raw.replay.it.%d", time.Now().UnixNano())

	writer := sentinelconnector.NewS3RawArchiveWriter(s3Client, "sentinel-archive")
	day := time.Now().UTC()
	archiveSyntheticRaw(t, writer, tenantID, day, 5, 0)

	produceClient := newTestKafkaClient(t)
	defer produceClient.Close()
	provisionTopic(t, produceClient, outputTopic)

	reader := sentinelconnector.NewS3RawArchiveReader(s3Client, "sentinel-archive")
	publisher := sentinelstream.NewRedpandaPublisher(produceClient, outputTopic)
	checkpoints := NewInMemoryCheckpointStore()
	replayer := NewReplayer(reader, publisher, checkpoints, slog.New(slog.NewTextHandler(os.Stderr, nil)))

	progress, err := replayer.Replay(context.Background(), "t1-job", tenantID, day.Add(-time.Hour), day.Add(time.Hour), identityConnector{})
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if progress.TotalEvents != 5 {
		t.Fatalf("expected 5 replayed events, got %d", progress.TotalEvents)
	}

	consumeClient := newTestKafkaClient(t,
		kgo.ConsumeTopics(outputTopic),
		kgo.ConsumerGroup("replay-t1-"+fmt.Sprint(time.Now().UnixNano())),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
	)
	defer consumeClient.Close()

	seen := map[int]bool{}
	deadline := time.Now().Add(20 * time.Second)
	for len(seen) < 5 && time.Now().Before(deadline) {
		fetchCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		fetches := consumeClient.PollFetches(fetchCtx)
		cancel()
		fetches.EachRecord(func(rec *kgo.Record) {
			var ev ocsf.Event
			if err := json.Unmarshal(rec.Value, &ev); err != nil {
				t.Fatalf("unmarshalling replayed record: %v", err)
			}
			if ev.TenantID != tenantID {
				t.Fatalf("replayed event has tenant_id=%q, want %q", ev.TenantID, tenantID)
			}
			var payload struct{ Seq int }
			if err := json.Unmarshal(ev.RawData, &payload); err != nil {
				t.Fatalf("unmarshalling RawData: %v", err)
			}
			seen[payload.Seq] = true
		})
	}
	if len(seen) != 5 {
		t.Fatalf("expected to see all 5 replayed seq values on %s, got %d: %v", outputTopic, len(seen), seen)
	}
}

// T2: replaying the SAME archived range TWICE (a different job id each
// time, deliberately — this bypasses checkpointing so the test actually
// exercises downstream dedup, not just "the checkpoint prevented a
// repeat") produces no duplicate STORED rows after ClickHouse's
// ReplacingMergeTree merges — the real AC2 claim, proven end to end.
func TestReplayingTwiceProducesNoDuplicateRowsAfterMerge(t *testing.T) {
	s3Client := newTestS3Client(t)
	tenantID := fmt.Sprintf("71000000-0000-4000-8000-%012d", time.Now().UnixNano()%1_000_000_000_000)
	outputTopic := fmt.Sprintf("events.raw.replay.it.%d", time.Now().UnixNano())

	writer := sentinelconnector.NewS3RawArchiveWriter(s3Client, "sentinel-archive")
	day := time.Now().UTC()
	const n = 20
	archiveSyntheticRaw(t, writer, tenantID, day, n, 0)

	produceClient := newTestKafkaClient(t)
	defer produceClient.Close()
	provisionTopic(t, produceClient, outputTopic)

	reader := sentinelconnector.NewS3RawArchiveReader(s3Client, "sentinel-archive")
	publisher := sentinelstream.NewRedpandaPublisher(produceClient, outputTopic)

	// Two independent jobs over the identical range — the operator-error
	// scenario AC2 actually guards against.
	for _, jobID := range []string{"t2-job-a", "t2-job-b"} {
		checkpoints := NewInMemoryCheckpointStore()
		replayer := NewReplayer(reader, publisher, checkpoints, slog.New(slog.NewTextHandler(os.Stderr, nil)))
		if _, err := replayer.Replay(context.Background(), jobID, tenantID, day.Add(-time.Hour), day.Add(time.Hour), identityConnector{}); err != nil {
			t.Fatalf("Replay (%s): %v", jobID, err)
		}
	}

	bridgeConsumeClient := newTestKafkaClient(t,
		kgo.ConsumeTopics(outputTopic),
		kgo.ConsumerGroup("replay-t2-bridge-"+fmt.Sprint(time.Now().UnixNano())),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
	)
	defer bridgeConsumeClient.Close()
	normalizedProduceClient := newTestKafkaClient(t)
	defer normalizedProduceClient.Close()

	writerConsumeClient := newTestKafkaClient(t,
		kgo.ConsumeTopics(sentinelstream.EventsNormalized),
		kgo.ConsumerGroup("replay-t2-writer-"+fmt.Sprint(time.Now().UnixNano())),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtEnd()),
	)
	defer writerConsumeClient.Close()

	chWriter, err := sentinelevents.NewClickHouseWriter("localhost:9000", "sentinel", "default", "")
	if err != nil {
		t.Fatalf("connecting ClickHouse writer: %v", err)
	}
	defer chWriter.Close()

	var written int
	consumer := sentinelevents.NewConsumer(writerConsumeClient, chWriter, sentinelevents.ConsumerOptions{
		Trigger: sentinelevents.BatchTrigger{MaxRows: 100, MaxAge: time.Second},
		Log:     slog.New(slog.NewTextHandler(os.Stderr, nil)),
		OnWrite: func(rows int) { written += rows },
	})
	consumerCtx, cancelConsumer := context.WithCancel(context.Background())
	consumerDone := make(chan struct{})
	go func() { defer close(consumerDone); _ = consumer.Run(consumerCtx) }()

	// Bridge every record this test's two replay jobs produced (2*n
	// total, since neither job shares a checkpoint) onto events.normalized,
	// then let the consumer drain it into ClickHouse.
	deadline := time.Now().Add(30 * time.Second)
	bridged := 0
	for bridged < 2*n && time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		n, err := runBridgeOnce(ctx, bridgeConsumeClient, normalizedProduceClient, outputTopic)
		cancel()
		if err != nil {
			t.Fatalf("bridge: %v", err)
		}
		bridged += n
	}
	if bridged != 2*n {
		t.Fatalf("expected to bridge %d records (2 replay jobs x %d events), got %d", 2*n, n, bridged)
	}

	drainDeadline := time.Now().Add(20 * time.Second)
	for written < 2*n && time.Now().Before(drainDeadline) {
		time.Sleep(500 * time.Millisecond)
	}
	cancelConsumer()
	<-consumerDone

	chConn, err := chConnect(t)
	if err != nil {
		t.Fatalf("connecting for reconciliation: %v", err)
	}
	defer chConn.Close()
	if err := chConn.Exec(context.Background(), "OPTIMIZE TABLE sentinel.events FINAL"); err != nil {
		t.Fatalf("OPTIMIZE TABLE FINAL: %v", err)
	}
	var storedCount uint64
	if err := chConn.QueryRow(context.Background(), fmt.Sprintf("SELECT count() FROM sentinel.events WHERE tenant_id = '%s'", tenantID)).Scan(&storedCount); err != nil {
		t.Fatalf("counting stored rows: %v", err)
	}

	// The real AC2 claim: TWO independent replay jobs over the identical
	// archived range still collapse to exactly n stored rows, not 2n —
	// proven by ClickHouse's own ReplacingMergeTree merge, not by this
	// test's own bookkeeping.
	if storedCount != uint64(n) {
		t.Fatalf("expected exactly %d stored rows after merging two independent replays of the same range, got %d (duplication)", n, storedCount)
	}
}

// T4 (load): replaying 7 days for a 100-seat tenant completes inside 10
// minutes. No per-seat event volume is documented anywhere in this
// repo for M365 audit-style activity logs, so this uses a deliberately
// round, defensible estimate — 500 events/seat/day (a commonly cited
// ballpark for general M365 activity auditing) — giving 100 x 500 x 7 =
// 350,000 events, archived across 70 objects (10/day, the shape a real
// connector running every couple of hours would actually produce, not
// one giant object per day). Retuning the per-seat estimate later is a
// one-line change to eventsPerSeatPerDay below, not a redesign.
func TestReplay7DaysFor100SeatTenantCompletesInTenMinutes(t *testing.T) {
	s3Client := newTestS3Client(t)
	tenantID := fmt.Sprintf("72000000-0000-4000-8000-%012d", time.Now().UnixNano()%1_000_000_000_000)
	outputTopic := fmt.Sprintf("events.raw.replay.it.%d", time.Now().UnixNano())

	const (
		seats               = 100
		eventsPerSeatPerDay = 500
		days                = 7
		objectsPerDay       = 10
	)
	eventsPerDay := seats * eventsPerSeatPerDay
	eventsPerObject := eventsPerDay / objectsPerDay
	totalEvents := eventsPerDay * days

	writer := sentinelconnector.NewS3RawArchiveWriter(s3Client, "sentinel-archive")
	start := time.Now().UTC().AddDate(0, 0, -days)
	t.Logf("archiving %d synthetic events across %d days x %d objects/day...", totalEvents, days, objectsPerDay)
	for d := 0; d < days; d++ {
		day := start.AddDate(0, 0, d)
		for o := 0; o < objectsPerDay; o++ {
			archiveSyntheticRaw(t, writer, tenantID, day.Add(time.Duration(o)*time.Hour), eventsPerObject, (d*objectsPerDay+o)*eventsPerObject)
		}
	}

	produceClient := newTestKafkaClient(t)
	defer produceClient.Close()
	provisionTopic(t, produceClient, outputTopic)

	reader := sentinelconnector.NewS3RawArchiveReader(s3Client, "sentinel-archive")
	publisher := sentinelstream.NewRedpandaPublisher(produceClient, outputTopic)
	checkpoints := NewInMemoryCheckpointStore()
	replayer := NewReplayer(reader, publisher, checkpoints, slog.New(slog.NewTextHandler(os.Stderr, nil)))

	replayStart := time.Now()
	progress, err := replayer.Replay(context.Background(), "t4-load-job", tenantID, start.Add(-time.Hour), start.AddDate(0, 0, days).Add(time.Hour), identityConnector{})
	elapsed := time.Since(replayStart)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if progress.TotalEvents != int64(totalEvents) {
		t.Fatalf("expected %d events replayed, got %d", totalEvents, progress.TotalEvents)
	}

	t.Logf("replayed %d events across %d objects in %s (budget: 10m)", progress.TotalEvents, progress.TotalObjects, elapsed)
	if elapsed > 10*time.Minute {
		t.Fatalf("AC5: expected a 7-day/100-seat replay to complete within 10 minutes, took %s", elapsed)
	}
}

// T3 (integration half — the deterministic unit half, using
// InMemoryCheckpointStore, is TestReplayResumesFromCheckpointAfterInterruption
// in replay_test.go): the SAME resume property, but with the checkpoint
// genuinely persisted to and read back from the real S3-compatible store
// — proving S3CheckpointStore's own Load/Save round-trip, not just the
// Replayer orchestration logic the unit test already covers against a
// fake.
func TestReplayResumesFromCheckpointViaRealS3CheckpointStore(t *testing.T) {
	s3Client := newTestS3Client(t)
	tenantID := fmt.Sprintf("73000000-0000-4000-8000-%012d", time.Now().UnixNano()%1_000_000_000_000)

	writer := sentinelconnector.NewS3RawArchiveWriter(s3Client, "sentinel-archive")
	day := time.Now().UTC()
	// 5 separate objects (not 1 batch of 5 events) — the checkpoint
	// granularity is per OBJECT, so this needs multiple objects for a
	// partial-completion-then-resume to have anything meaningful to
	// checkpoint between.
	for i := 0; i < 5; i++ {
		archiveSyntheticRaw(t, writer, tenantID, day.Add(time.Duration(i)*time.Hour), 1, i)
	}

	reader := sentinelconnector.NewS3RawArchiveReader(s3Client, "sentinel-archive")
	checkpoints := NewS3CheckpointStore(s3Client, "sentinel-archive")
	jobID := fmt.Sprintf("t3-s3-job-%d", time.Now().UnixNano())

	// First attempt: fails partway through (same simulated-interruption
	// technique as the unit test), via a publisher that errors after 3 calls.
	innerPub1 := sentinelconnector.NewInMemoryPublisher()
	failingPub := &failAfterNPublisher{inner: innerPub1, failFrom: 3}
	r1 := NewReplayer(reader, failingPub, checkpoints, slog.New(slog.NewTextHandler(os.Stderr, nil)))
	progress1, err := r1.Replay(context.Background(), jobID, tenantID, day.Add(-time.Hour), day.Add(6*time.Hour), identityConnector{})
	if err == nil {
		t.Fatal("expected the first attempt to fail partway through")
	}
	if progress1.ProcessedObjects != 2 {
		t.Fatalf("expected exactly 2 objects checkpointed to S3 before the simulated failure, got %d", progress1.ProcessedObjects)
	}

	// Load the checkpoint back via a FRESH S3CheckpointStore instance
	// (not the same Go value) — proving this really round-tripped through
	// S3, not just an in-process field that happened to still be set.
	freshCheckpoints := NewS3CheckpointStore(s3Client, "sentinel-archive")
	innerPub2 := sentinelconnector.NewInMemoryPublisher()
	r2 := NewReplayer(reader, innerPub2, freshCheckpoints, slog.New(slog.NewTextHandler(os.Stderr, nil)))
	progress2, err := r2.Replay(context.Background(), jobID, tenantID, day.Add(-time.Hour), day.Add(6*time.Hour), identityConnector{})
	if err != nil {
		t.Fatalf("expected the resumed attempt to complete, got: %v", err)
	}
	if progress2.ProcessedObjects != 5 {
		t.Fatalf("expected all 5 objects reflected as processed after resuming via S3, got %d", progress2.ProcessedObjects)
	}
	if published := innerPub2.Published(tenantID); len(published) != 3 {
		t.Fatalf("expected the resumed run to publish exactly the 3 remaining events, got %d", len(published))
	}
}
