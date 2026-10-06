//go:build integration

package worker

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelsignal"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/detectgen"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/dispatch"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

const brokers = "localhost:19092"
const corpusDir = "../../../../detections/rules"

func randomID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("generating random id: %v", err)
	}
	return fmt.Sprintf("%x", b)
}

// TestMain truncates events.normalized and signals before this package's
// integration tests run — the same reasoning
// go/sentinelevents/consumer_integration_test.go's own TestMain gives:
// every fresh consumer group here reads AtStart(), which only stays fast
// and correct when earlier runs (including other packages' own load
// tests) have not left millions of irrelevant records on these topics.
func TestMain(m *testing.M) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if client, err := kgo.NewClient(kgo.SeedBrokers(brokers)); err == nil {
		admin := kadm.NewClient(client)
		for _, topic := range []string{sentinelstream.EventsNormalized, sentinelstream.Signals} {
			if end, err := admin.ListEndOffsets(ctx, topic); err == nil {
				_, _ = admin.DeleteRecords(ctx, end.Offsets())
			}
		}
		client.Close()
	}
	os.Exit(m.Run())
}

func buildRealTree(t *testing.T) *dispatch.Tree {
	t.Helper()
	rules, errs := sigmac.ParseCorpus(corpusDir)
	if len(errs) != 0 {
		t.Fatalf("parsing corpus: %v", errs)
	}
	tree, err := dispatch.Build(rules, detectgen.Rules, dispatch.Options{})
	if err != nil {
		t.Fatalf("dispatch.Build: %v", err)
	}
	return tree
}

func newWorker(t *testing.T, group string) (*Worker, *kgo.Client, *kgo.Client) {
	t.Helper()
	consumer, err := kgo.NewClient(
		kgo.SeedBrokers(brokers),
		kgo.ConsumeTopics(sentinelstream.EventsNormalized),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		t.Fatalf("creating consumer client: %v", err)
	}
	producer, err := kgo.NewClient(kgo.SeedBrokers(brokers))
	if err != nil {
		t.Fatalf("creating producer client: %v", err)
	}
	w := New(buildRealTree(t), consumer, producer, Options{Group: group})
	return w, consumer, producer
}

func produceWireEvent(t *testing.T, ev wireEvent) {
	t.Helper()
	client, err := kgo.NewClient(kgo.SeedBrokers(brokers))
	if err != nil {
		t.Fatalf("creating producer client: %v", err)
	}
	defer client.Close()
	payload, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshalling event: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res := client.ProduceSync(ctx, &kgo.Record{Topic: sentinelstream.EventsNormalized, Key: []byte(ev.TenantID), Value: payload})
	if err := res.FirstErr(); err != nil {
		t.Fatalf("producing event: %v", err)
	}
}

// collectSignals reads every signal published for tenantID from a fresh
// consumer group over `signals`, AtStart, until n have arrived or the
// deadline passes.
func collectSignals(t *testing.T, tenantID string, n int, timeout time.Duration) []sentinelsignal.Signal {
	t.Helper()
	group := "test-collect-" + randomID(t)
	client, err := kgo.NewClient(
		kgo.SeedBrokers(brokers),
		kgo.ConsumeTopics(sentinelstream.Signals),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
	)
	if err != nil {
		t.Fatalf("creating signals consumer: %v", err)
	}
	defer client.Close()

	var got []sentinelsignal.Signal
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) && len(got) < n {
		ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
		fetches := client.PollFetches(ctx)
		cancel()
		fetches.EachRecord(func(r *kgo.Record) {
			var sig sentinelsignal.Signal
			if err := json.Unmarshal(r.Value, &sig); err != nil {
				return
			}
			if sig.TenantID == tenantID {
				got = append(got, sig)
			}
		})
	}
	return got
}

// T1: a known malicious event sequence produces exactly the expected
// signal set. "New-InboxRule" is new-inbox-forwarding-rule.yml's own
// positive fixture (detections/fixtures/new-inbox-forwarding-rule.positive.json)
// reproduced as a real wire event, chosen specifically because, among the
// 8-rule corpus, it is the only in-stream rule whose selection matches
// this Operation value — proven by P2-03's own exhaustive-evaluation fuzz
// test, not asserted on faith here.
func TestWorker_KnownMaliciousSequenceProducesExpectedSignals(t *testing.T) {
	tenantID := randomID(t)
	eventID := "evt-" + tenantID
	group := "test-detect-t1-" + tenantID

	w, consumer, producer := newWorker(t, group)
	defer consumer.Close()
	defer producer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go func() { _ = w.Run(ctx) }()

	produceWireEvent(t, wireEvent{
		TenantID: tenantID,
		EventID:  eventID,
		ClassUID: 3005, ActivityID: 1, SeverityID: 1,
		Metadata: map[string]string{"product": "m365", "operation": "New-InboxRule"},
	})

	got := collectSignals(t, tenantID, 1, 15*time.Second)
	if len(got) != 1 {
		t.Fatalf("got %d signals for tenant %s, want exactly 1: %+v", len(got), tenantID, got)
	}
	sig := got[0]
	if sig.RuleID != "8f1a2b3c-0001-4a00-9000-000000000001" {
		t.Errorf("RuleID = %q, want the new-inbox-forwarding-rule id", sig.RuleID)
	}
	if sig.EventID != eventID {
		t.Errorf("EventID = %q, want %q", sig.EventID, eventID)
	}
	if sig.Severity != "medium" {
		t.Errorf("Severity = %q, want medium", sig.Severity)
	}
	if len(sig.MitreIDs) != 1 || sig.MitreIDs[0] != "attack.t1114.003" {
		t.Errorf("MitreIDs = %v, want [attack.t1114.003]", sig.MitreIDs)
	}
}

// T2: a worker crash mid-batch replays without losing signals. Worker A
// consumes the record but is stopped (simulating a crash) before its
// poll's own CommitUncommittedOffsets ever runs — achieved the same way
// go/sentinelevents's own T1 proves it, by giving it a context that
// expires before a poll cycle completes. Worker B, same group, fresh
// client, must still produce the signal: the record was never committed,
// so AtStart's own committed-offset resume point is still before it.
func TestWorker_CrashMidBatchReplaysWithoutLosingSignals(t *testing.T) {
	tenantID := randomID(t)
	eventID := "evt-" + tenantID
	group := "test-detect-t2-" + tenantID

	produceWireEvent(t, wireEvent{
		TenantID: tenantID,
		EventID:  eventID,
		ClassUID: 3005, ActivityID: 1, SeverityID: 1,
		Metadata: map[string]string{"product": "m365", "operation": "New-InboxRule"},
	})

	consumerA, err := kgo.NewClient(
		kgo.SeedBrokers(brokers),
		kgo.ConsumeTopics(sentinelstream.EventsNormalized),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		t.Fatalf("creating consumer A: %v", err)
	}
	producerA, err := kgo.NewClient(kgo.SeedBrokers(brokers))
	if err != nil {
		t.Fatalf("creating producer A: %v", err)
	}
	workerA := New(buildRealTree(t), consumerA, producerA, Options{Group: group})

	// A context that expires mid-poll, before Run's own loop ever reaches
	// CommitUncommittedOffsets — the crash this test simulates.
	ctxA, cancelA := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	_ = workerA.Run(ctxA)
	cancelA()
	consumerA.Close()
	producerA.Close()

	// Worker B: same group, fresh clients — must pick up from the last
	// COMMITTED offset, which worker A never advanced.
	w, consumerB, producerB := newWorker(t, group)
	defer consumerB.Close()
	defer producerB.Close()

	ctxB, cancelB := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelB()
	go func() { _ = w.Run(ctxB) }()

	got := collectSignals(t, tenantID, 1, 15*time.Second)
	if len(got) < 1 {
		t.Fatalf("got %d signals for tenant %s after restart, want at least 1 (no loss)", len(got), tenantID)
	}
	if got[0].EventID != eventID {
		t.Errorf("EventID = %q, want %q", got[0].EventID, eventID)
	}
}
