//go:build integration

package azure

import (
	"context"
	"testing"
	"time"

	azeventhubs "github.com/Azure/azure-sdk-for-go/sdk/messaging/azeventhubs/v2"
)

// Requires: pnpm dev:stack (brings up `eventhubs-emulator` + its required
// `azurite` sidecar — a real implementation of Event Hubs' own AMQP wire
// protocol, see docker-compose.dev.yml's own doc comment for why). Run via:
//
//	go test -tags=integration ./go/sentinelconnector/azure/...
//
// Connection string is Microsoft's own documented emulator literal
// (test-locally-with-event-hub-emulator docs) — SAS_KEY_VALUE is not a
// placeholder to replace; the emulator accepts it verbatim because
// UseDevelopmentEmulator=true tells the SDK to skip real signature
// verification entirely.
const emulatorConnectionString = "Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;"
const emulatorEventHubName = "entra-diagnostics" // matches infra/docker/eventhubs-emulator-config.json's own entity name

func newRealConsumerClient(t *testing.T) *azeventhubs.ConsumerClient {
	t.Helper()
	client, err := azeventhubs.NewConsumerClientFromConnectionString(emulatorConnectionString, emulatorEventHubName, azeventhubs.DefaultConsumerGroup, nil)
	if err != nil {
		t.Fatalf("creating consumer client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close(context.Background()) })
	return client
}

func sendTestEvent(t *testing.T, partitionID, body string) {
	t.Helper()
	producer, err := azeventhubs.NewProducerClientFromConnectionString(emulatorConnectionString, emulatorEventHubName, nil)
	if err != nil {
		t.Fatalf("creating producer client: %v", err)
	}
	defer producer.Close(context.Background())

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	batch, err := producer.NewEventDataBatch(ctx, &azeventhubs.EventDataBatchOptions{PartitionID: &partitionID})
	if err != nil {
		t.Fatalf("creating batch: %v", err)
	}
	if err := batch.AddEventData(&azeventhubs.EventData{Body: []byte(body)}, nil); err != nil {
		t.Fatalf("adding event to batch: %v", err)
	}
	if err := producer.SendEventDataBatch(ctx, batch, nil); err != nil {
		t.Fatalf("sending batch: %v", err)
	}
}

// T1: "Event Hub consumption with checkpoint recovery after restart" —
// against a REAL Event Hubs server (the emulator), not a fake. Fetch
// receives a real event, then a brand-new Connector instance (a genuine
// restart) given the previously-returned cursor resumes from exactly
// the committed sequence number, seeing only what's genuinely new.
func TestFetch_AgainstRealEventHub_CheckpointSurvivesRestart(t *testing.T) {
	const partitionID = "0"
	sendTestEvent(t, partitionID, `{"category":"SignInLogs","properties":{"id":"real-1","resultType":"0"}}`)

	client1 := newRealConsumerClient(t)
	conn1 := NewConnector(testTenantID, client1)
	batch1, cur1, err := conn1.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("first Fetch: %v", err)
	}
	if len(batch1.Events) == 0 {
		t.Fatal("expected at least 1 real event from the emulator")
	}

	sendTestEvent(t, partitionID, `{"category":"SignInLogs","properties":{"id":"real-2","resultType":"0"}}`)

	// A brand-new ConsumerClient AND a brand-new Connector — a genuine
	// restart, given the previously-committed cursor.
	client2 := newRealConsumerClient(t)
	conn2 := NewConnector(testTenantID, client2)
	batch2, _, err := conn2.Fetch(context.Background(), cur1)
	if err != nil {
		t.Fatalf("second Fetch (post-restart): %v", err)
	}

	foundNew, foundOld := false, false
	for _, ev := range batch2.Events {
		mapped := MapEvent(testTenantID, Stream, ev.Payload, ev.FetchedAt)
		if mapped.EventID == MapEvent(testTenantID, Stream, []byte(`{"category":"SignInLogs","properties":{"id":"real-2","resultType":"0"}}`), ev.FetchedAt).EventID {
			foundNew = true
		}
		if mapped.EventID == MapEvent(testTenantID, Stream, []byte(`{"category":"SignInLogs","properties":{"id":"real-1","resultType":"0"}}`), ev.FetchedAt).EventID {
			foundOld = true
		}
	}
	if !foundNew {
		t.Error("expected the NEW event (real-2) to be received after restart")
	}
	if foundOld {
		t.Error("expected the OLD, already-checkpointed event (real-1) to NOT be re-delivered after restart")
	}
}
