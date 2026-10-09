//go:build integration

package aws

import (
	"context"
	"crypto/rand"
	"fmt"
	"testing"
	"time"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// Requires: pnpm dev:stack (brings up the `sqs` service — ElasticMQ, a
// real implementation of SQS's own wire protocol, see
// infra/docker/elasticmq.conf's own doc comment for why). Run via:
//
//	go test -tags=integration ./go/sentinelconnector/aws/...
const elasticMQEndpoint = "http://localhost:9324"

func randomSuffix(t *testing.T) string {
	t.Helper()
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("generating random suffix: %v", err)
	}
	return fmt.Sprintf("%x", b)
}

func newRealSQSClient(t *testing.T) *sqs.Client {
	t.Helper()
	return sqs.New(sqs.Options{
		Region:       "elasticmq",
		Credentials:  credentials.NewStaticCredentialsProvider("x", "x", ""),
		BaseEndpoint: awssdk.String(elasticMQEndpoint),
	})
}

// createTestQueue creates a uniquely-named queue for this test run and
// deletes it on cleanup — the "randomUUID-scoped resource, cleaned up in
// t.Cleanup" convention this repo's other integration tests already use
// for tenants/topics (see elasticmq.conf's own doc comment for why this
// package doesn't rely on auto-create-queues).
func createTestQueue(t *testing.T, client *sqs.Client) string {
	t.Helper()
	name := "p7-02-test-" + randomSuffix(t)
	out, err := client.CreateQueue(context.Background(), &sqs.CreateQueueInput{QueueName: &name})
	if err != nil {
		t.Fatalf("creating test queue: %v", err)
	}
	t.Cleanup(func() {
		_, _ = client.DeleteQueue(context.Background(), &sqs.DeleteQueueInput{QueueUrl: out.QueueUrl})
	})
	return *out.QueueUrl
}

func sendTestMessage(t *testing.T, client *sqs.Client, queueURL, body string) {
	t.Helper()
	if _, err := client.SendMessage(context.Background(), &sqs.SendMessageInput{QueueUrl: &queueURL, MessageBody: &body}); err != nil {
		t.Fatalf("sending test message: %v", err)
	}
}

// T1 (the SQS-consumption half — role assumption against a real AWS
// account is not available in this sandbox; see the PR's own disclosure):
// against a REAL SQS-protocol server, Fetch receives a real message and
// defers its deletion to the following cycle.
func TestFetch_AgainstRealSQS_ReceivesAndDefersDeletion(t *testing.T) {
	client := newRealSQSClient(t)
	queueURL := createTestQueue(t, client)
	sendTestMessage(t, client, queueURL, `{"eventID":"real-1","eventTime":"2024-01-01T00:00:00Z","eventName":"ConsoleLogin"}`)

	conn := NewConnector(testTenantID, queueURL, client)
	batch, cur1, err := conn.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(batch.Events) != 1 {
		t.Fatalf("expected 1 real event from ElasticMQ, got %d", len(batch.Events))
	}

	// Not yet deleted — a second ReceiveMessage must see nothing new
	// (the message is invisible, per real SQS visibility-timeout
	// semantics) rather than returning it again right away.
	out, err := client.ReceiveMessage(context.Background(), &sqs.ReceiveMessageInput{QueueUrl: &queueURL, MaxNumberOfMessages: 10})
	if err != nil {
		t.Fatalf("probing queue state: %v", err)
	}
	if len(out.Messages) != 0 {
		t.Fatalf("expected the in-flight message to stay invisible, but ReceiveMessage returned %d", len(out.Messages))
	}

	// The next Fetch (given cur1) deletes it for real against ElasticMQ.
	sendTestMessage(t, client, queueURL, `{"eventID":"real-2","eventTime":"2024-01-01T00:01:00Z","eventName":"AssumeRole"}`)
	batch2, _, err := conn.Fetch(context.Background(), cur1)
	if err != nil {
		t.Fatalf("second Fetch: %v", err)
	}
	if len(batch2.Events) != 1 {
		t.Fatalf("expected 1 new event, got %d", len(batch2.Events))
	}
}

// T2, proven against the REAL protocol's own visibility-timeout
// mechanism (not simulated): a message received but never deleted
// becomes visible again on its own, after its real visibility timeout
// expires, and is genuinely redelivered — exactly "a consumer crash
// before deletion results in redelivery, not loss."
func TestFetch_AgainstRealSQS_RedeliversAfterVisibilityTimeoutExpires(t *testing.T) {
	client := newRealSQSClient(t)
	queueURL := createTestQueue(t, client)
	sendTestMessage(t, client, queueURL, `{"eventID":"redelivery-1","eventTime":"2024-01-01T00:00:00Z","eventName":"ConsoleLogin"}`)

	conn := NewConnector(testTenantID, queueURL, client).WithVisibilityTimeout(2)
	batch1, _, err := conn.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(batch1.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(batch1.Events))
	}

	// Simulate a crash: never call Fetch again with the cursor that
	// would have deleted this message. Wait out the real visibility
	// timeout instead.
	time.Sleep(3 * time.Second)

	// A brand-new connector instance, no cursor at all — the same state
	// a genuine restart with a never-committed cursor would be in.
	conn2 := NewConnector(testTenantID, queueURL, client).WithVisibilityTimeout(2)
	batch2, _, err := conn2.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("post-expiry Fetch: %v", err)
	}
	if len(batch2.Events) != 1 {
		t.Fatalf("expected the never-deleted message to be genuinely redelivered by ElasticMQ after its visibility timeout, got %d events", len(batch2.Events))
	}
}
