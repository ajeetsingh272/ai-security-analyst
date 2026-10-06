//go:build integration

package sentinelevents

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

const normalizedTopic = "events.normalized"
const composeFile = "../../infra/docker/docker-compose.dev.yml"

func randomTenantID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("generating random tenant id: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// TestMain truncates events.normalized before this package's integration
// tests run. T1/T2 both use fresh consumer groups with AtStart() — on
// purpose: T1's whole premise is "a fresh group re-reads what an
// uncommitted crash left behind", which only works if EVERY fresh group in
// the test reads from the same starting point when nothing has been
// committed, i.e. the topic's actual beginning. That's fine on an empty
// topic. It stops being fine once P1-07's own T3 load test leaves 27M+
// records here: every fresh group then has to churn through all of them
// before reaching a test's own handful of rows — found the hard way, T1/T2
// timing out immediately after T3's first full run, not because Consumer
// broke, but because the test harness was asking it to read 27 million
// irrelevant records first. Deleting old records (not the topic — DLQ
// routing tests still need it provisioned) is the fix that keeps AtStart()
// correct rather than working around it.
func TestMain(m *testing.M) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if client, err := kgo.NewClient(kgo.SeedBrokers("localhost:19092")); err == nil {
		admin := kadm.NewClient(client)
		if end, err := admin.ListEndOffsets(ctx, normalizedTopic); err == nil {
			_, _ = admin.DeleteRecords(ctx, end.Offsets())
		}
		client.Close()
	}
	os.Exit(m.Run())
}

func produceEvents(t *testing.T, tenantID string, n int) {
	t.Helper()
	client, err := kgo.NewClient(kgo.SeedBrokers("localhost:19092"))
	if err != nil {
		t.Fatalf("creating producer client: %v", err)
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	records := make([]*kgo.Record, n)
	for i := 0; i < n; i++ {
		row := EventRow{
			TenantID: tenantID, EventID: fmt.Sprintf("%s-%d", tenantID, i), Time: time.Now(),
			ClassUID: 3002, CategoryUID: 3, ActivityID: 1, TypeUID: 300201, SeverityID: 1,
			ActorUserUID: "u1", StatusID: 1, Message: "integration test event",
		}
		payload, _ := json.Marshal(row)
		records[i] = &kgo.Record{Topic: normalizedTopic, Key: []byte(tenantID + ":0"), Value: payload}
	}
	results := client.ProduceSync(ctx, records...)
	if err := results.FirstErr(); err != nil {
		t.Fatalf("producing test events: %v", err)
	}
}

func countRowsForTenant(t *testing.T, w *ClickHouseWriter, tenantID string) uint64 {
	t.Helper()
	var count uint64
	if err := w.conn.QueryRow(context.Background(),
		"SELECT count() FROM sentinel.events WHERE tenant_id = ?", tenantID,
	).Scan(&count); err != nil {
		t.Fatalf("counting rows: %v", err)
	}
	return count
}

func cleanupTenant(t *testing.T, w *ClickHouseWriter, tenantID string) {
	t.Helper()
	_ = w.conn.Exec(context.Background(), "ALTER TABLE sentinel.events DELETE WHERE tenant_id = ?", tenantID)
}

// T1: a consumer that crashes before committing replays those records from
// a fresh consumer in the same group — no data loss, because nothing was
// ever acknowledged as done.
func TestConsumerRestartReplaysUncommittedOffsets(t *testing.T) {
	tenantID := randomTenantID(t)
	const n = 10
	produceEvents(t, tenantID, n)

	writer := newTestWriter(t)
	t.Cleanup(func() { cleanupTenant(t, writer, tenantID) })
	group := "test-restart-" + tenantID

	// Consumer A: a trigger that will NEVER fire on its own within this
	// test's short run (MaxRows huge, MaxAge long) — it reads records into
	// memory and deliberately never gets the chance to flush or commit
	// before being stopped, simulating a crash mid-batch.
	clientA, err := kgo.NewClient(
		kgo.SeedBrokers("localhost:19092"),
		kgo.ConsumeTopics(normalizedTopic),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		t.Fatalf("creating consumer A: %v", err)
	}
	consumerA := NewConsumer(clientA, writer, ConsumerOptions{Trigger: BatchTrigger{MaxRows: 100000, MaxAge: time.Hour}})

	ctxA, cancelA := context.WithTimeout(context.Background(), 5*time.Second)
	_ = consumerA.Run(ctxA) // runs until its own timeout, never flushes
	cancelA()
	clientA.Close()

	if got := countRowsForTenant(t, writer, tenantID); got != 0 {
		t.Fatalf("consumer A should not have written anything (never flushed), but found %d rows", got)
	}

	// Consumer B: same group, fresh client — must pick up from the last
	// COMMITTED offset, which consumer A never advanced.
	clientB, err := kgo.NewClient(
		kgo.SeedBrokers("localhost:19092"),
		kgo.ConsumeTopics(normalizedTopic),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		t.Fatalf("creating consumer B: %v", err)
	}
	defer clientB.Close()
	consumerB := NewConsumer(clientB, writer, ConsumerOptions{Trigger: BatchTrigger{MaxRows: 1, MaxAge: time.Second}})

	ctxB, cancelB := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelB()
	go func() { _ = consumerB.Run(ctxB) }()

	deadline := time.Now().Add(9 * time.Second)
	for time.Now().Before(deadline) {
		if countRowsForTenant(t, writer, tenantID) >= n {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	if got := countRowsForTenant(t, writer, tenantID); got != n {
		t.Fatalf("expected exactly %d rows after restart (no loss, no duplicates), got %d", n, got)
	}
}

func dockerCompose(t *testing.T, args ...string) {
	t.Helper()
	cmd := exec.Command("docker", append([]string{"compose", "-f", composeFile}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("docker compose %v: %v\n%s", args, err, out)
	}
}

func safeUnpauseClickHouse(t *testing.T) {
	t.Helper()
	cmd := exec.Command("docker", "compose", "-f", composeFile, "unpause", "clickhouse")
	out, err := cmd.CombinedOutput()
	if err != nil && !bytes.Contains(out, []byte("is not paused")) {
		t.Errorf("cleanup: docker compose unpause clickhouse: %v\n%s", err, out)
	}
}

// T2: ClickHouse unavailability pauses consumption (the writer errors, the
// consumer does not commit, does not crash, and does not drop the batch)
// and the consumer catches up cleanly once ClickHouse is back — no loss.
//
// Pauses the real ClickHouse container, the same proven-safe pattern as
// P1-05's T3 (a frozen process answers no network traffic at all, the
// genuine failure mode) — never a large data generation, which is what
// actually caused the incident documented in P1-06's commit message.
func TestClickHouseOutagePausesConsumptionAndRecoversWithoutLoss(t *testing.T) {
	tenantID := randomTenantID(t)
	const n = 5
	produceEvents(t, tenantID, n)

	writer := newTestWriter(t)
	t.Cleanup(func() { cleanupTenant(t, writer, tenantID) })
	t.Cleanup(func() { safeUnpauseClickHouse(t) })

	group := "test-outage-" + tenantID
	client, err := kgo.NewClient(
		kgo.SeedBrokers("localhost:19092"),
		kgo.ConsumeTopics(normalizedTopic),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		t.Fatalf("creating consumer: %v", err)
	}
	defer client.Close()
	consumer := NewConsumer(client, writer, ConsumerOptions{Trigger: BatchTrigger{MaxRows: 1, MaxAge: 500 * time.Millisecond}})

	dockerCompose(t, "pause", "clickhouse")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- consumer.Run(ctx) }()

	// Let the consumer actually hit the outage and fail a write attempt or
	// two before lifting it.
	time.Sleep(3 * time.Second)
	dockerCompose(t, "unpause", "clickhouse")

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if countRowsForTenant(t, writer, tenantID) >= n {
			break
		}
		time.Sleep(300 * time.Millisecond)
	}

	if got := countRowsForTenant(t, writer, tenantID); got != n {
		t.Fatalf("expected exactly %d rows after ClickHouse recovered, got %d (loss or the consumer never retried)", n, got)
	}

	cancel()
	select {
	case <-runErr:
	case <-time.After(5 * time.Second):
		t.Fatal("consumer.Run did not return after context cancellation")
	}
}
