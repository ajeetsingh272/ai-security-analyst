package azure

import (
	"context"
	"encoding/json"
	"testing"

	azeventhubs "github.com/Azure/azure-sdk-for-go/sdk/messaging/azeventhubs/v2"
)

const testTenantID = "88888888-8888-4888-8888-888888888888"

// fakeEventHubClient/fakePartitionReceiver are in-memory test doubles —
// prove this package's own Fetch/cursor logic without a real AMQP
// connection; the real protocol is proven separately against the Azure
// Event Hubs emulator (eventhub_integration_test.go).
type fakeEventHubClient struct {
	partitionIDs []string
	events       map[string][]azeventhubs.ReceivedEventData // partitionID -> events, in sequence order
}

func newFakeEventHubClient(partitionIDs ...string) *fakeEventHubClient {
	return &fakeEventHubClient{partitionIDs: partitionIDs, events: map[string][]azeventhubs.ReceivedEventData{}}
}

func (f *fakeEventHubClient) addEvent(partitionID string, seq int64, body string) {
	f.events[partitionID] = append(f.events[partitionID], azeventhubs.ReceivedEventData{
		EventData:      azeventhubs.EventData{Body: []byte(body)},
		SequenceNumber: seq,
	})
}

func (f *fakeEventHubClient) GetEventHubProperties(_ context.Context, _ *azeventhubs.GetEventHubPropertiesOptions) (azeventhubs.EventHubProperties, error) {
	return azeventhubs.EventHubProperties{PartitionIDs: f.partitionIDs}, nil
}

func (f *fakeEventHubClient) NewPartitionClient(partitionID string, options *azeventhubs.PartitionClientOptions) (*azeventhubs.PartitionClient, error) {
	// Never called directly in tests — Connector.newPartitionClient is
	// overridden below to bypass the real SDK type entirely, since
	// *azeventhubs.PartitionClient cannot be constructed without a real
	// AMQP connection.
	panic("not used in tests — override Connector.newPartitionClient instead")
}

type fakePartitionReceiver struct {
	toReturn []*azeventhubs.ReceivedEventData
	closed   bool
}

func (f *fakePartitionReceiver) ReceiveEvents(_ context.Context, count int, _ *azeventhubs.ReceiveEventsOptions) ([]*azeventhubs.ReceivedEventData, error) {
	if count < len(f.toReturn) {
		return f.toReturn[:count], nil
	}
	return f.toReturn, nil
}

func (f *fakePartitionReceiver) Close(_ context.Context) error {
	f.closed = true
	return nil
}

// newTestConnector wires a Connector against the fake client, with
// newPartitionClient overridden to read directly from the fake's own
// per-partition event slice rather than going through the (unusable in
// tests) real NewPartitionClient.
func newTestConnector(fake *fakeEventHubClient) *Connector {
	c := NewConnector(testTenantID, fake)
	c.newPartitionClient = func(partitionID string, opts *azeventhubs.PartitionClientOptions) (partitionReceiver, error) {
		all := fake.events[partitionID]
		var filtered []*azeventhubs.ReceivedEventData
		for i := range all {
			ev := all[i]
			if opts.StartPosition.SequenceNumber != nil && ev.SequenceNumber <= *opts.StartPosition.SequenceNumber {
				continue
			}
			filtered = append(filtered, &ev)
		}
		return &fakePartitionReceiver{toReturn: filtered}, nil
	}
	return c
}

// T1 (unit half): Fetch receives events from every partition and
// advances each partition's own cursor independently.
func TestFetch_ReceivesFromEveryPartitionIndependently(t *testing.T) {
	fake := newFakeEventHubClient("0", "1")
	fake.addEvent("0", 10, `{"category":"SignInLogs","properties":{"id":"a"}}`)
	fake.addEvent("1", 20, `{"category":"AuditLogs","properties":{"id":"b","activityDisplayName":"Add user"}}`)

	conn := newTestConnector(fake)
	batch, nextCur, err := conn.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(batch.Events) != 2 {
		t.Fatalf("expected 2 events across 2 partitions, got %d", len(batch.Events))
	}

	var state cursorState
	if err := json.Unmarshal(nextCur, &state); err != nil {
		t.Fatalf("decoding cursor: %v", err)
	}
	if state.Partitions["0"] != 10 || state.Partitions["1"] != 20 {
		t.Fatalf("expected per-partition checkpoints {0:10, 1:20}, got %+v", state.Partitions)
	}
}

// T1 (checkpoint-recovery half): a restart (brand-new Connector
// instance) given the previously-returned cursor resumes exactly where
// it left off — no loss, no duplication.
func TestFetch_RestartResumesFromCommittedSequenceNumber(t *testing.T) {
	fake := newFakeEventHubClient("0")
	fake.addEvent("0", 1, `{"category":"SignInLogs","properties":{"id":"a"}}`)
	fake.addEvent("0", 2, `{"category":"SignInLogs","properties":{"id":"b"}}`)

	conn1 := newTestConnector(fake)
	batch1, cur1, err := conn1.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("first Fetch: %v", err)
	}
	if len(batch1.Events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(batch1.Events))
	}

	fake.addEvent("0", 3, `{"category":"SignInLogs","properties":{"id":"c"}}`)

	conn2 := newTestConnector(fake) // brand-new instance, same as a genuine restart
	batch2, _, err := conn2.Fetch(context.Background(), cur1)
	if err != nil {
		t.Fatalf("second Fetch (post-restart): %v", err)
	}
	if len(batch2.Events) != 1 {
		t.Fatalf("expected exactly 1 NEW event after restart, got %d", len(batch2.Events))
	}
}

// A brand-new partition (sequence number 0 is a legitimate, real first
// value — not a sentinel for "never checked") must still be correctly
// checkpointed, proving the fix for the off-by-zero case the package
// doc comment's own cursor design flags.
func TestFetch_FirstEventEverOnAPartitionCanBeSequenceZero(t *testing.T) {
	fake := newFakeEventHubClient("0")
	fake.addEvent("0", 0, `{"category":"SignInLogs","properties":{"id":"a"}}`)

	conn := newTestConnector(fake)
	batch, nextCur, err := conn.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(batch.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(batch.Events))
	}
	var state cursorState
	_ = json.Unmarshal(nextCur, &state)
	if seq, ok := state.Partitions["0"]; !ok || seq != 0 {
		t.Fatalf("expected partition 0's checkpoint to be recorded as sequence 0, got %+v (ok=%v)", state.Partitions, ok)
	}

	// A second Fetch with this cursor must NOT re-receive the same event.
	batch2, _, err := conn.Fetch(context.Background(), nextCur)
	if err != nil {
		t.Fatalf("second Fetch: %v", err)
	}
	if len(batch2.Events) != 0 {
		t.Fatalf("expected 0 events (sequence 0 already checkpointed), got %d", len(batch2.Events))
	}
}

func TestID_IsAzure(t *testing.T) {
	conn := newTestConnector(newFakeEventHubClient())
	if conn.ID() != "azure" {
		t.Fatalf("ID() = %q, want %q", conn.ID(), "azure")
	}
}
