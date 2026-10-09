// Package aws is P7-02 — the AWS CloudTrail connector, delivered via
// EventBridge to SQS (the third connector, after m365 and google, and
// the first push-sourced one built against a real vendor API rather than
// syslog's raw-socket precedent).
//
// Architecture note, resolved deliberately before writing this file:
// overview.md §3.1 labels AWS "Push", grouping it with syslog — but that
// label describes the AWS-SIDE data flow (CloudTrail pushes into
// EventBridge, which pushes into SQS), not this connector's own runtime
// shape. From here, SQS is a queue THIS PROCESS must call ReceiveMessage
// against, repeatedly — a poll loop in every way that matters, far closer
// to m365/google's own vendor-API Fetch than to syslog's passive
// Listener. This package is built as an SQS long-poll loop accordingly.
//
// Setup prerequisite (AC1, "documented for the customer"): the
// customer's own EventBridge rule target must be configured with an input
// path of $.detail, so each SQS message body is the raw CloudTrail
// record JSON directly — not EventBridge's own wrapping envelope. This is
// a standard, documented EventBridge target option (Terraform:
// aws_cloudwatch_event_target's input_path), not something this
// connector itself can enforce, hence "documented for the customer"
// rather than "handled transparently."
//
// Cursor design (AC5/T2 — "message loss is impossible... deletion occurs
// only after durable write", worked through carefully since SQS does not
// fit go/sentinelconnector's Cursor abstraction the way a vendor
// pagination token does — there is no "give me everything after X" SQS
// parameter to persist):
//
// Fetch(ctx, cur) is called by the scheduler with cur = the LAST
// COMMITTED cursor, and ADR-0010 guarantees a cursor is only ever
// committed AFTER the batch it was returned alongside was durably
// published. So by the time THIS Fetch call receives cur as its
// argument, every receipt handle encoded in it is PROVEN already
// published — safe to DeleteMessage. This connector exploits that
// guarantee directly: Fetch's FIRST action is deleting the previous
// batch's messages (now proven safe), and its LAST action is receiving a
// NEW batch and returning ITS receipt handles as the new cursor — to be
// deleted on the FOLLOWING call, once THAT batch is proven published in
// turn. A crash between Fetch returning and the cursor actually being
// committed means the next restart re-reads the OLD (still the last
// genuinely committed) cursor and retries the same delete — DeleteMessage
// on an already-deleted or revisibility-expired receipt handle is itself
// safe (AWS returns an error for an invalid handle, nothing is
// corrupted) — and whatever was received but never deleted simply
// becomes visible again after its visibility timeout and is redelivered
// on a later cycle. That IS T2's own scenario, satisfied by this
// package's own Fetch/cursor design, with zero scheduler changes.
package aws

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
)

// ID is the literal "kind" string — already a legal value in the
// connectors table's own check constraint since P1's foundation migration,
// so this connector needs no schema migration of its own (confirmed the
// same way P7-01's own research confirmed 'google_workspace' already was).
const ID sentinelconnector.ConnectorID = "aws"

// Stream is the one stream name this connector registers under — AWS has
// only the single CloudTrail management-events queue this ticket scopes
// to (AC2's "SQS consumption"), unlike M365's four content types or
// Google's five application names, so there is no per-tenant slice to
// iterate the way those two have — one Connector instance per tenant.
const Stream = "cloudtrail"

// visibilityTimeoutSeconds must comfortably exceed one scheduler cycle
// interval, same "far longer than the polling interval" reasoning
// m365/google's own refreshSkewSeconds gives for token refresh — a
// message that's still being processed (or whose delete is merely
// pending until the NEXT Fetch call, per this package's own cursor
// design above) must not become visible again and get redelivered to a
// concurrent cycle before this one has had a real chance to finish.
const visibilityTimeoutSeconds = 120

// maxMessagesPerReceive is SQS's own hard ceiling for one ReceiveMessage
// call (AWS API limit, not a choice this package makes).
const maxMessagesPerReceive = 10

// waitTimeSeconds enables SQS long-polling — the AWS-recommended way to
// avoid a hot-polling empty-queue loop, costing nothing extra in this
// scheduler's own tick-based model since a long poll simply returns
// early the moment a message arrives.
const waitTimeSeconds = 10

// sqsAPI is the narrow interface this package actually depends on — a
// real *sqs.Client satisfies it structurally, same "narrow interface,
// concrete type satisfies it, fake for tests" shape every other
// credential/token interface in this codebase already uses.
type sqsAPI interface {
	ReceiveMessage(ctx context.Context, params *sqs.ReceiveMessageInput, optFns ...func(*sqs.Options)) (*sqs.ReceiveMessageOutput, error)
	DeleteMessage(ctx context.Context, params *sqs.DeleteMessageInput, optFns ...func(*sqs.Options)) (*sqs.DeleteMessageOutput, error)
}

// cursorState is this connector's own Cursor payload — see the package
// doc comment above for why it carries pending-delete receipt handles
// rather than a vendor resume token.
type cursorState struct {
	PendingDeleteReceiptHandles []string `json:"pendingDeleteReceiptHandles,omitempty"`
}

// Connector implements sentinelconnector.Connector for one (Sentinel
// tenant, AWS account) pair.
type Connector struct {
	tenantID          string
	queueURL          string
	sqs               sqsAPI
	visibilityTimeout int32
}

// NewConnector wires one tenant's connector. sqsClient is typically a
// real *sqs.Client configured with the tenant's own assumed-role
// credentials (see NewConnectorForTenant below, the production
// composition path) — accepting the interface directly here, rather than
// building the client inside this constructor, is what makes this type
// testable against a fake with no network/credentials at all.
func NewConnector(tenantID, queueURL string, sqsClient sqsAPI) *Connector {
	return &Connector{tenantID: tenantID, queueURL: queueURL, sqs: sqsClient, visibilityTimeout: visibilityTimeoutSeconds}
}

// WithVisibilityTimeout overrides the default visibility timeout
// (visibilityTimeoutSeconds) — production never calls this; it exists so
// an integration test against a real SQS-protocol server can prove real
// redelivery-after-expiry (T2) in seconds rather than waiting out the
// production default.
func (c *Connector) WithVisibilityTimeout(seconds int32) *Connector {
	c.visibilityTimeout = seconds
	return c
}

// NewConnectorForTenant is the production composition path — builds a
// real *sqs.Client from the tenant's stored role ARN/external id via STS
// AssumeRole (roleprovider.go), region- and queue-scoped per creds (AC1).
// stsClient is typically a real *sts.Client; accepted as the narrow
// stscreds.AssumeRoleAPIClient interface for the exact same testability
// reason NewConnector's own sqsClient parameter is an interface.
func NewConnectorForTenant(tenantID string, stsClient stscreds.AssumeRoleAPIClient, creds Credentials, sqsBaseEndpoint string) *Connector {
	credsCache := newCredentialsProvider(stsClient, creds)
	sqsClient := sqs.New(sqs.Options{
		Region:      creds.Region,
		Credentials: credsCache,
		BaseEndpoint: func() *string {
			if sqsBaseEndpoint == "" {
				return nil
			}
			return &sqsBaseEndpoint
		}(),
	})
	return NewConnector(tenantID, creds.QueueURL, sqsClient)
}

func (c *Connector) ID() sentinelconnector.ConnectorID { return ID }

// Fetch is this package's own idempotent-per-cursor contract — see the
// package doc comment for the full reasoning. Concretely: delete the
// previous batch (now proven published), then receive a new one.
func (c *Connector) Fetch(ctx context.Context, cur sentinelconnector.Cursor) (sentinelconnector.Batch, sentinelconnector.Cursor, error) {
	state := decodeCursor(cur)
	for _, handle := range state.PendingDeleteReceiptHandles {
		_, err := c.sqs.DeleteMessage(ctx, &sqs.DeleteMessageInput{QueueUrl: &c.queueURL, ReceiptHandle: &handle})
		if err != nil && !isInvalidReceiptHandle(err) {
			// A transient AWS-side failure (not "this handle is already
			// gone") must fail the cycle — silently swallowing it would
			// mean these messages are never retried for deletion, and
			// never redelivered either until their OWN visibility
			// timeout eventually lapses on its own.
			return sentinelconnector.Batch{}, nil, fmt.Errorf("aws: deleting previous batch's message: %w", err)
		}
	}

	out, err := c.sqs.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
		QueueUrl:            &c.queueURL,
		MaxNumberOfMessages: maxMessagesPerReceive,
		WaitTimeSeconds:     waitTimeSeconds,
		VisibilityTimeout:   c.visibilityTimeout,
	})
	if err != nil {
		return sentinelconnector.Batch{}, nil, fmt.Errorf("aws: receiving from SQS: %w", err)
	}

	var events []sentinelconnector.RawEvent
	var receiptHandles []string
	now := time.Now().Unix()
	for _, msg := range out.Messages {
		if msg.ReceiptHandle != nil {
			receiptHandles = append(receiptHandles, *msg.ReceiptHandle)
		}
		if msg.Body == nil {
			continue // nothing to normalise; the handle above still gets deleted next cycle, same as any other received message
		}
		events = append(events, sentinelconnector.RawEvent{
			TenantID:  c.tenantID,
			Payload:   []byte(*msg.Body),
			FetchedAt: now,
		})
	}

	nextCur, err := json.Marshal(cursorState{PendingDeleteReceiptHandles: receiptHandles})
	if err != nil {
		return sentinelconnector.Batch{}, nil, fmt.Errorf("aws: encoding cursor: %w", err)
	}
	return sentinelconnector.Batch{Events: events}, sentinelconnector.Cursor(nextCur), nil
}

func decodeCursor(cur sentinelconnector.Cursor) cursorState {
	if len(cur) == 0 {
		return cursorState{}
	}
	var state cursorState
	_ = json.Unmarshal(cur, &state) // malformed/empty cursor degrades to "nothing pending", never a crash
	return state
}

// isInvalidReceiptHandle recognises SQS's own error for a receipt handle
// that's no longer valid (already deleted, or the message was received
// again under a new handle after its visibility timeout lapsed) — this is
// an EXPECTED, harmless outcome of this package's own delete-next-cycle
// design under a slow or crashed cycle, not a real failure.
func isInvalidReceiptHandle(err error) bool {
	type apiError interface{ ErrorCode() string }
	var apiErr apiError
	if ae, ok := err.(apiError); ok {
		apiErr = ae
	}
	if apiErr == nil {
		return false
	}
	code := apiErr.ErrorCode()
	return code == "ReceiptHandleIsInvalid" || code == "InvalidParameterValue"
}

// Normalise wires this connector to MapEvent (ocsf_mapping.go) — one
// event per RawEvent, mirroring m365/google's identical contract. AC1's
// own setup prerequisite (EventBridge target input_path = $.detail) is
// what makes raw.Payload the bare CloudTrail record JSON MapEvent parses.
func (c *Connector) Normalise(raw sentinelconnector.RawEvent) ([]ocsf.Event, error) {
	return []ocsf.Event{MapEvent(raw.TenantID, Stream, raw.Payload, raw.FetchedAt)}, nil
}

// HealthCheck proves the connector can still assume its role — forcing a
// credential retrieval surfaces an untrusted/deleted role the same way
// m365/google's own HealthCheck surfaces a revoked OAuth grant.
func (c *Connector) HealthCheck(ctx context.Context) error {
	_, err := c.sqs.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
		QueueUrl:            &c.queueURL,
		MaxNumberOfMessages: 1,
		VisibilityTimeout:   0,
		WaitTimeSeconds:     0,
	})
	if err != nil && stsErrorIsAccessDenied(err) {
		return fmt.Errorf("aws: role no longer assumable: %w", sentinelconnector.ErrConsentRevoked)
	}
	return err
}
