//go:build integration

package sentinelstream

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os/exec"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

// Requires: pnpm dev:stack (Redpanda on localhost:19092). Run via:
//
//	go test -tags=integration ./...

func newTestClient(t *testing.T, opts ...kgo.Opt) *kgo.Client {
	t.Helper()
	client, err := kgo.NewClient(append([]kgo.Opt{kgo.SeedBrokers("localhost:19092")}, opts...)...)
	if err != nil {
		t.Fatalf("creating kafka client: %v", err)
	}
	t.Cleanup(client.Close)
	return client
}

// randomTenantID generates a fresh UUID-v4-shaped id per test run, so
// repeated runs (and T2/T3 running against the same shared events.raw
// topic) never collide on the same partition key.
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

// T1: topic provisioning is idempotent across repeated runs.
func TestProvisionIsIdempotent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client := newTestClient(t)
	provisioner := NewProvisioner(client)

	if err := provisioner.Apply(ctx); err != nil {
		t.Fatalf("first Apply: %v", err)
	}
	// The actual assertion: re-applying must NOT error just because
	// everything already exists.
	if err := provisioner.Apply(ctx); err != nil {
		t.Fatalf("second Apply (idempotent re-run) failed: %v", err)
	}

	admin := kadm.NewClient(client)
	names := make([]string, 0, len(MainTopics)*2)
	for _, spec := range MainTopics {
		names = append(names, spec.Name, spec.DLQ)
	}
	details, err := admin.ListTopics(ctx, names...)
	if err != nil {
		t.Fatalf("ListTopics: %v", err)
	}

	for _, spec := range MainTopics {
		d, ok := details[spec.Name]
		if !ok || d.Err != nil {
			t.Fatalf("topic %s missing or errored: ok=%v err=%v", spec.Name, ok, d.Err)
		}
		if got := int32(len(d.Partitions)); got != spec.Partitions {
			t.Fatalf("topic %s: expected %d partitions, got %d", spec.Name, spec.Partitions, got)
		}
		dlq, ok := details[spec.DLQ]
		if !ok || dlq.Err != nil {
			t.Fatalf("DLQ topic %s missing or errored: ok=%v err=%v", spec.DLQ, ok, dlq.Err)
		}
		if got := int32(len(dlq.Partitions)); got != dlqPartitions {
			t.Fatalf("DLQ %s: expected %d partitions, got %d", spec.DLQ, dlqPartitions, got)
		}
	}
}

// T2: events for one tenant arrive in production order on a single
// partition.
func TestEventsArriveInOrderOnOnePartition(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	provisionClient := newTestClient(t)
	if err := NewProvisioner(provisionClient).Apply(ctx); err != nil {
		t.Fatalf("provisioning: %v", err)
	}

	producerClient := newTestClient(t)
	publisher := NewRedpandaPublisher(producerClient, EventsRaw)

	tenantID := randomTenantID(t)
	const n = 20
	envelopes := make([]sentinelconnector.EventEnvelope, n)
	for i := 0; i < n; i++ {
		payload, _ := json.Marshal(map[string]any{"seq": i, "tenant": tenantID})
		envelopes[i] = sentinelconnector.EventEnvelope{TenantID: tenantID, Payload: payload}
	}
	if err := publisher.Publish(ctx, tenantID, envelopes); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	consumerClient := newTestClient(t,
		kgo.ConsumeTopics(EventsRaw),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.ConsumerGroup("test-order-"+tenantID),
	)

	type seen struct {
		seq       int
		partition int32
	}
	var collected []seen
	deadline := time.Now().Add(20 * time.Second)
	for len(collected) < n && time.Now().Before(deadline) {
		fetchCtx, fetchCancel := context.WithTimeout(ctx, 3*time.Second)
		fetches := consumerClient.PollFetches(fetchCtx)
		fetchCancel()
		fetches.EachRecord(func(r *kgo.Record) {
			var v struct {
				Seq    int    `json:"seq"`
				Tenant string `json:"tenant"`
			}
			if err := json.Unmarshal(r.Value, &v); err != nil || v.Tenant != tenantID {
				return // another test's data on the shared topic — ignore
			}
			collected = append(collected, seen{seq: v.Seq, partition: r.Partition})
		})
	}

	if len(collected) != n {
		t.Fatalf("expected to consume %d events for tenant %s, got %d", n, tenantID, len(collected))
	}

	firstPartition := collected[0].partition
	for i, rec := range collected {
		if rec.partition != firstPartition {
			t.Fatalf("event %d landed on partition %d, expected all on partition %d (same tenant key must route to one partition)", i, rec.partition, firstPartition)
		}
		if rec.seq != i {
			t.Fatalf("production order not preserved: position %d holds seq %d, expected %d", i, rec.seq, i)
		}
	}
}

const composeFile = "../../infra/docker/docker-compose.dev.yml"

func dockerCompose(t *testing.T, args ...string) {
	t.Helper()
	cmd := exec.Command("docker", append([]string{"compose", "-f", composeFile}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("docker compose %v: %v\n%s", args, err, out)
	}
}

// safeUnpause is the cleanup-time unpause specifically: it must never leave
// the container paused, but it must also not fail the test just because the
// test body's OWN unpause already ran — "already unpaused" is success for a
// cleanup whose only job is "don't leave this paused", not an error.
func safeUnpause(t *testing.T) {
	t.Helper()
	cmd := exec.Command("docker", "compose", "-f", composeFile, "unpause", "redpanda")
	out, err := cmd.CombinedOutput()
	if err != nil && !bytes.Contains(out, []byte("is not paused")) {
		t.Errorf("cleanup: docker compose unpause redpanda: %v\n%s", err, out)
	}
}

// T3: the producer retries through a real broker outage without duplicating
// or reordering. Simulated by pausing (not stopping) the actual Redpanda
// container — a frozen process stops answering any network traffic, which
// is what makes this a genuine outage from the client's point of view,
// rather than a clean connection-refused that doesn't exercise the same
// retry path a real partial-network-failure would.
//
// The container is ALWAYS unpaused before this test returns, including on
// failure — registered via t.Cleanup before the pause happens, specifically
// so a t.Fatal partway through still leaves the dev stack usable.
func TestProducerRetriesThroughBrokerOutageWithoutDuplicatingOrReordering(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	provisionClient := newTestClient(t)
	if err := NewProvisioner(provisionClient).Apply(ctx); err != nil {
		t.Fatalf("provisioning: %v", err)
	}

	// Registered before the pause, unconditionally, so the dev stack is
	// never left frozen even if everything below fails.
	t.Cleanup(func() { safeUnpause(t) })

	tenantID := randomTenantID(t)
	const n = 10
	envelopes := make([]sentinelconnector.EventEnvelope, n)
	for i := 0; i < n; i++ {
		payload, _ := json.Marshal(map[string]any{"seq": i, "tenant": tenantID})
		envelopes[i] = sentinelconnector.EventEnvelope{TenantID: tenantID, Payload: payload}
	}

	producerClient := newTestClient(t)
	publisher := NewRedpandaPublisher(producerClient, EventsRaw)

	dockerCompose(t, "pause", "redpanda")

	publishErr := make(chan error, 1)
	go func() { publishErr <- publisher.Publish(ctx, tenantID, envelopes) }()

	// Let the producer actually hit the outage and start retrying before
	// lifting it — the point of this test is the retry path, not a
	// trivially-fast happy path that never saw the broker go away.
	time.Sleep(3 * time.Second)
	dockerCompose(t, "unpause", "redpanda")

	select {
	case err := <-publishErr:
		if err != nil {
			t.Fatalf("Publish did not recover from the outage: %v", err)
		}
	case <-time.After(45 * time.Second):
		t.Fatal("Publish did not return within 45s of the broker being unpaused")
	}

	consumerClient := newTestClient(t,
		kgo.ConsumeTopics(EventsRaw),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.ConsumerGroup("test-outage-"+tenantID),
	)
	var collected []int
	deadline := time.Now().Add(20 * time.Second)
	for len(collected) < n && time.Now().Before(deadline) {
		fetchCtx, fetchCancel := context.WithTimeout(ctx, 3*time.Second)
		fetches := consumerClient.PollFetches(fetchCtx)
		fetchCancel()
		fetches.EachRecord(func(r *kgo.Record) {
			var v struct {
				Seq    int    `json:"seq"`
				Tenant string `json:"tenant"`
			}
			if err := json.Unmarshal(r.Value, &v); err != nil || v.Tenant != tenantID {
				return
			}
			collected = append(collected, v.Seq)
		})
	}

	if len(collected) != n {
		t.Fatalf("expected exactly %d events (no duplicates, none lost) after the outage, got %d: %v", n, len(collected), collected)
	}
	for i, seq := range collected {
		if seq != i {
			t.Fatalf("reordering after outage recovery: position %d holds seq %d, expected %d (full sequence: %v)", i, seq, i, collected)
		}
	}
}
