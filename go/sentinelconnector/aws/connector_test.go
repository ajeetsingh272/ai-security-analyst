package aws

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
	smithy "github.com/aws/smithy-go"
)

const testTenantID = "77777777-7777-4777-8777-777777777777"
const testQueueURL = "http://sqs.local/000000000000/test-queue"

// fakeSQS is an in-memory sqsAPI — proves this package's own Fetch/cursor
// logic (T1/T2 at the unit level) without a real SQS server; the real
// protocol's visibility-timeout/redelivery semantics are proven
// separately, against ElasticMQ, in cursor_integration_test.go.
type fakeSQS struct {
	// pending simulates the queue's own in-flight state: messages that
	// have been received (so excluded from the NEXT ReceiveMessage call)
	// but not yet deleted — exactly SQS's own visibility-timeout model,
	// simplified to "stays invisible forever until Deleted" (no simulated
	// expiry), since that's the half this fake needs to prove the cursor
	// design's call sequence, not SQS's own timing.
	queued  []types.Message
	pending map[string]types.Message // receiptHandle -> message
	deleted []string
	nextID  int
}

func newFakeSQS() *fakeSQS { return &fakeSQS{pending: map[string]types.Message{}} }

func (f *fakeSQS) enqueue(body string) {
	f.nextID++
	id := fmt.Sprintf("msg-%d", f.nextID)
	f.queued = append(f.queued, types.Message{MessageId: &id, Body: strPtr(body), ReceiptHandle: strPtr("rh-" + id)})
}

func strPtr(s string) *string { return &s }

func (f *fakeSQS) ReceiveMessage(_ context.Context, params *sqs.ReceiveMessageInput, _ ...func(*sqs.Options)) (*sqs.ReceiveMessageOutput, error) {
	max := int(params.MaxNumberOfMessages)
	if max <= 0 {
		max = 1
	}
	var out []types.Message
	for len(f.queued) > 0 && len(out) < max {
		msg := f.queued[0]
		f.queued = f.queued[1:]
		f.pending[*msg.ReceiptHandle] = msg
		out = append(out, msg)
	}
	return &sqs.ReceiveMessageOutput{Messages: out}, nil
}

func (f *fakeSQS) DeleteMessage(_ context.Context, params *sqs.DeleteMessageInput, _ ...func(*sqs.Options)) (*sqs.DeleteMessageOutput, error) {
	handle := *params.ReceiptHandle
	if _, ok := f.pending[handle]; !ok {
		return nil, &smithy.GenericAPIError{Code: "ReceiptHandleIsInvalid", Message: "not found"}
	}
	delete(f.pending, handle)
	f.deleted = append(f.deleted, handle)
	return &sqs.DeleteMessageOutput{}, nil
}

// requeue simulates a message's visibility timeout lapsing (e.g. the
// consumer crashed before deleting it) — it goes back into the queue
// under the SAME receipt handle, matching this fake's own simplified
// model (a real SQS would issue a NEW receipt handle on redelivery; this
// fake only needs to prove "it comes back", not handle identity churn).
func (f *fakeSQS) requeue(handle string) {
	msg, ok := f.pending[handle]
	if !ok {
		return
	}
	delete(f.pending, handle)
	f.queued = append(f.queued, msg)
}

// T1 (unit half): Fetch receives messages and returns them as RawEvents,
// with their receipt handles carried in the next cursor — not yet
// deleted.
func TestFetch_ReceivesMessagesAndDefersDeletion(t *testing.T) {
	fake := newFakeSQS()
	fake.enqueue(`{"eventID":"e1","eventName":"ConsoleLogin"}`)
	fake.enqueue(`{"eventID":"e2","eventName":"AssumeRole"}`)

	conn := NewConnector(testTenantID, testQueueURL, fake)
	batch, nextCur, err := conn.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(batch.Events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(batch.Events))
	}
	if len(fake.deleted) != 0 {
		t.Fatalf("expected NOTHING deleted on the first Fetch (nothing was proven published yet), got %v", fake.deleted)
	}

	var state cursorState
	if err := json.Unmarshal(nextCur, &state); err != nil {
		t.Fatalf("decoding cursor: %v", err)
	}
	if len(state.PendingDeleteReceiptHandles) != 2 {
		t.Fatalf("expected 2 pending-delete receipt handles in the cursor, got %d", len(state.PendingDeleteReceiptHandles))
	}
}

// The core of the design: the NEXT Fetch call (given the cursor the
// PREVIOUS one returned) deletes that previous batch FIRST, before
// receiving anything new — proving "deletion occurs only after durable
// write" (AC5), since receiving that cursor as input is itself proof the
// previous batch was already committed/published (ADR-0010).
func TestFetch_DeletesPreviousBatchBeforeReceivingNext(t *testing.T) {
	fake := newFakeSQS()
	fake.enqueue(`{"eventID":"e1","eventName":"ConsoleLogin"}`)

	conn := NewConnector(testTenantID, testQueueURL, fake)
	_, cur1, err := conn.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("first Fetch: %v", err)
	}

	fake.enqueue(`{"eventID":"e2","eventName":"AssumeRole"}`)

	batch2, _, err := conn.Fetch(context.Background(), cur1)
	if err != nil {
		t.Fatalf("second Fetch: %v", err)
	}
	if len(fake.deleted) != 1 {
		t.Fatalf("expected exactly 1 message deleted (the first batch's), got %d: %v", len(fake.deleted), fake.deleted)
	}
	if len(batch2.Events) != 1 {
		t.Fatalf("expected 1 new event, got %d", len(batch2.Events))
	}
}

// T2: "A consumer crash before deletion results in redelivery, not
// loss." Simulated by calling Fetch once (receiving but not yet
// deleting), then — WITHOUT ever calling Fetch again with that cursor —
// forcing the message to become visible again (requeue, standing in for
// a real visibility-timeout lapse) and proving a FRESH Fetch(nil) (a
// brand-new connector instance, as a genuine restart with a lost/never-
// persisted cursor would see) still sees it: never silently lost.
func TestFetch_CrashBeforeDeleteResultsInRedeliveryNotLoss(t *testing.T) {
	fake := newFakeSQS()
	fake.enqueue(`{"eventID":"e1","eventName":"ConsoleLogin"}`)

	conn1 := NewConnector(testTenantID, testQueueURL, fake)
	batch1, _, err := conn1.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(batch1.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(batch1.Events))
	}
	// Simulate: the process crashed right here — the cursor returned
	// above was NEVER committed, and the message's visibility timeout
	// eventually lapses.
	fake.requeue("rh-msg-1")

	// A brand-new connector instance, given no cursor at all (the
	// genuinely last-committed state, since the crash happened before
	// the previous cycle's cursor was ever written) — a real restart.
	conn2 := NewConnector(testTenantID, testQueueURL, fake)
	batch2, _, err := conn2.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("post-crash Fetch: %v", err)
	}
	if len(batch2.Events) != 1 {
		t.Fatalf("expected the never-deleted message to be REDELIVERED after the crash, got %d events", len(batch2.Events))
	}
}

// Deleting an already-invalid/expired receipt handle (the OTHER half of
// the crash scenario — the cursor DID get committed, but the message had
// ALREADY become visible again and been redelivered under what this test
// doesn't model as a new handle, so the old one is simply gone by the
// time Fetch tries to delete it) must not fail the whole cycle.
func TestFetch_DeletingAnAlreadyInvalidHandleIsNotFatal(t *testing.T) {
	fake := newFakeSQS()
	fake.enqueue(`{"eventID":"e1","eventName":"ConsoleLogin"}`)

	conn := NewConnector(testTenantID, testQueueURL, fake)
	_, cur1, err := conn.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("first Fetch: %v", err)
	}
	// The message is deleted out-of-band (standing in for "it already
	// became invalid for some other reason") before the connector itself
	// gets to it on the next cycle.
	delete(fake.pending, "rh-msg-1")

	if _, _, err := conn.Fetch(context.Background(), cur1); err != nil {
		t.Fatalf("expected deleting an already-invalid handle to be tolerated, got error: %v", err)
	}
}

func TestID_IsAWS(t *testing.T) {
	conn := NewConnector(testTenantID, testQueueURL, newFakeSQS())
	if conn.ID() != "aws" {
		t.Fatalf("ID() = %q, want %q", conn.ID(), "aws")
	}
}
