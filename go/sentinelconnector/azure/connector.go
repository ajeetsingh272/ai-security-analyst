// Package azure is P7-03 — the Azure/Entra ID connector, delivered via
// diagnostic settings routed to an Event Hub (the fourth connector,
// after m365, google, and aws).
//
// Architecture note, resolved the same way go/sentinelconnector/aws's
// own package doc comment resolves AWS's identical labelling question:
// overview.md §3.1 calls this "Push", but that describes the AZURE-SIDE
// data flow (diagnostic settings push log records into an Event Hub),
// not this connector's own runtime shape. Consuming an Event Hub still
// requires THIS process to actively call ReceiveEvents per partition —
// a pull loop, same as AWS's own SQS resolution. Built accordingly.
//
// Cursor design — a MUCH better fit than AWS's own SQS resolution
// needed, worked out before writing code specifically because the two
// are NOT the same shape: SQS has no vendor-side resumable offset at
// all (hence AWS's receipt-handle replay-delete trick). Event Hubs
// genuinely has one — every ReceivedEventData carries its own
// SequenceNumber, and azeventhubs.PartitionClient accepts a
// StartPosition{SequenceNumber, Inclusive} at construction. This is
// EXACTLY what go/sentinelconnector's own Cursor abstraction was
// designed for (M365's blob id, Google's startTime+pageToken), so this
// package stores a plain map of partitionID -> last-processed sequence
// number in the ordinary connector_cursors row — no receipt-handle
// dance, no delete-next-cycle indirection, no Azure-side CheckpointStore
// (which would otherwise require Azure Blob Storage) at all. A crash
// before the next cursor commits just means the next Fetch re-reads
// from the OLD (still last-committed) sequence number, naturally
// idempotent the same way M365/Google's own poll-based Fetch already is
// — ADR-0010's ordinary replay tolerance, not a special case.
//
// Setup prerequisite (AC4, "documented with screenshots" —
// docs/connectors/azure-entra-setup.md): the customer routes Entra ID
// sign-in logs, audit logs, and Identity Protection risk detections into
// ONE Event Hub via diagnostic settings (Azure's own normal multiplexing
// behaviour for one diagnostic setting with multiple log categories
// enabled) — ocsf_mapping.go's own MapEvent branches on each record's
// "category" field, so the customer does not need separate Event Hubs
// per log category.
package azure

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	azeventhubs "github.com/Azure/azure-sdk-for-go/sdk/messaging/azeventhubs/v2"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
)

// ID is the literal "kind" string — already legal in the connectors
// table's own check constraint since P1's foundation migration
// (confirmed the same way every prior connector's own research
// confirmed its own kind value), so no schema migration is needed.
const ID sentinelconnector.ConnectorID = "azure"

// Stream is the one stream this connector registers under — every log
// category (sign-in, audit, risk detections) arrives multiplexed into
// the same Event Hub per this package's own setup prerequisite above.
const Stream = "entra-diagnostics"

// receiveTimeoutPerPartition bounds how long Fetch waits for new events
// on one partition before moving to the next — keeps one slow/empty
// partition from stalling the whole cycle indefinitely, mirroring SQS's
// own bounded long-poll (waitTimeSeconds) in go/sentinelconnector/aws.
const receiveTimeoutPerPartition = 10 * time.Second

const maxEventsPerPartitionPerCycle = 100

// eventHubClient is the narrow interface this package depends on for
// partition discovery and consumption — a real *azeventhubs.ConsumerClient
// satisfies it structurally, same "narrow interface, fake for tests"
// shape every other connector's own vendor-client dependency uses.
type eventHubClient interface {
	GetEventHubProperties(ctx context.Context, options *azeventhubs.GetEventHubPropertiesOptions) (azeventhubs.EventHubProperties, error)
	NewPartitionClient(partitionID string, options *azeventhubs.PartitionClientOptions) (*azeventhubs.PartitionClient, error)
}

// partitionReceiver is satisfied by *azeventhubs.PartitionClient —
// narrowed to the two methods Fetch actually calls, so a fake can stand
// in without a real AMQP connection for unit tests.
type partitionReceiver interface {
	ReceiveEvents(ctx context.Context, count int, options *azeventhubs.ReceiveEventsOptions) ([]*azeventhubs.ReceivedEventData, error)
	Close(ctx context.Context) error
}

// cursorState is this connector's own Cursor payload — see the package
// doc comment above for why this is a plain per-partition sequence-number
// map, unlike AWS's own receipt-handle design.
type cursorState struct {
	Partitions map[string]int64 `json:"partitions,omitempty"`
}

// Connector implements sentinelconnector.Connector for one (Sentinel
// tenant, Event Hub) pair.
type Connector struct {
	tenantID string
	client   eventHubClient
	// newPartitionClient is a seam over Connector.client.NewPartitionClient
	// purely for testability — production always calls through to the
	// real client; tests substitute a fake returning a fakePartitionReceiver
	// without needing eventHubClient itself to return the SDK's own
	// concrete *azeventhubs.PartitionClient type (which cannot be
	// constructed without a real AMQP connection).
	newPartitionClient func(partitionID string, opts *azeventhubs.PartitionClientOptions) (partitionReceiver, error)
}

// NewConnector wires one tenant's connector against a real or fake
// eventHubClient. Production code should use NewConnectorForTenant below.
func NewConnector(tenantID string, client eventHubClient) *Connector {
	return &Connector{
		tenantID: tenantID,
		client:   client,
		newPartitionClient: func(partitionID string, opts *azeventhubs.PartitionClientOptions) (partitionReceiver, error) {
			return client.NewPartitionClient(partitionID, opts)
		},
	}
}

// NewConnectorForTenant is the production composition path — builds a
// real *azeventhubs.ConsumerClient from the tenant's stored SAS
// connection string. consumerGroup defaults to "$Default" (the one
// consumer group every Event Hub always has, including the local
// emulator — see connector_test.go's own integration counterpart) when
// creds.ConsumerGroup is empty.
func NewConnectorForTenant(tenantID string, creds Credentials) (*Connector, error) {
	consumerGroup := creds.ConsumerGroup
	if consumerGroup == "" {
		consumerGroup = azeventhubs.DefaultConsumerGroup
	}
	client, err := azeventhubs.NewConsumerClientFromConnectionString(creds.ConnectionString, creds.EventHubName, consumerGroup, nil)
	if err != nil {
		return nil, fmt.Errorf("azure: creating consumer client: %w", err)
	}
	return NewConnector(tenantID, client), nil
}

func (c *Connector) ID() sentinelconnector.ConnectorID { return ID }

// Fetch receives new events from every partition since each one's own
// last-committed sequence number — see the package doc comment for why
// this needs no delete/replay indirection the way AWS's own Fetch does.
func (c *Connector) Fetch(ctx context.Context, cur sentinelconnector.Cursor) (sentinelconnector.Batch, sentinelconnector.Cursor, error) {
	state := decodeCursor(cur)
	if state.Partitions == nil {
		state.Partitions = map[string]int64{}
	}

	props, err := c.client.GetEventHubProperties(ctx, nil)
	if err != nil {
		return sentinelconnector.Batch{}, nil, fmt.Errorf("azure: getting event hub properties: %w", err)
	}

	var events []sentinelconnector.RawEvent
	nextPartitions := map[string]int64{}
	for k, v := range state.Partitions {
		nextPartitions[k] = v
	}

	now := time.Now().Unix()
	for _, partitionID := range props.PartitionIDs {
		lastSeq, hasCheckpoint := state.Partitions[partitionID]
		startPos := azeventhubs.StartPosition{Inclusive: false}
		if hasCheckpoint {
			startPos.SequenceNumber = &lastSeq
		} else {
			// First-ever cycle for this partition: start at the earliest
			// retained event — a deliberate, bounded-by-the-Event-Hub's-own-
			// retention-window scope choice, the same spirit as M365's own
			// 24h lookback default on a brand-new connector, just bounded by
			// whatever retention the customer's own Event Hub already has
			// rather than a second, independent limit this package would
			// have to invent.
			earliest := true
			startPos.Earliest = &earliest
		}

		pc, err := c.newPartitionClient(partitionID, &azeventhubs.PartitionClientOptions{StartPosition: startPos})
		if err != nil {
			return sentinelconnector.Batch{}, nil, fmt.Errorf("azure: opening partition client for %s: %w", partitionID, err)
		}

		received, recvErr := receiveWithTimeout(ctx, pc, maxEventsPerPartitionPerCycle)
		closeErr := pc.Close(ctx)
		if recvErr != nil {
			return sentinelconnector.Batch{}, nil, fmt.Errorf("azure: receiving from partition %s: %w", partitionID, recvErr)
		}
		if closeErr != nil {
			return sentinelconnector.Batch{}, nil, fmt.Errorf("azure: closing partition client for %s: %w", partitionID, closeErr)
		}

		// received is already in ascending sequence-number order (Event
		// Hubs delivers one partition's events in the order they were
		// published), so the LAST one is always the highest-seen — no
		// running max needed, and no zero-value-vs-"never set" ambiguity
		// a map default could otherwise introduce for a partition whose
		// very first-ever sequence number happens to be 0.
		for _, ev := range received {
			events = append(events, sentinelconnector.RawEvent{TenantID: c.tenantID, Payload: ev.Body, FetchedAt: now})
		}
		if len(received) > 0 {
			nextPartitions[partitionID] = received[len(received)-1].SequenceNumber
		}
	}

	nextCur, err := json.Marshal(cursorState{Partitions: nextPartitions})
	if err != nil {
		return sentinelconnector.Batch{}, nil, fmt.Errorf("azure: encoding cursor: %w", err)
	}
	return sentinelconnector.Batch{Events: events}, sentinelconnector.Cursor(nextCur), nil
}

// receiveWithTimeout bounds one partition's ReceiveEvents call —
// azeventhubs.PartitionClient.ReceiveEvents blocks until either `count`
// events arrive or ctx is done, so a per-partition deadline (rather than
// one shared deadline for the whole Fetch call) is what keeps an empty
// partition from silently eating every other partition's share of the
// cycle.
func receiveWithTimeout(ctx context.Context, pc partitionReceiver, count int) ([]*azeventhubs.ReceivedEventData, error) {
	timeoutCtx, cancel := context.WithTimeout(ctx, receiveTimeoutPerPartition)
	defer cancel()
	events, err := pc.ReceiveEvents(timeoutCtx, count, nil)
	if err != nil && timeoutCtx.Err() != nil {
		// A deadline with zero events available is the expected, common
		// case (an idle partition) — not a real failure.
		return events, nil
	}
	return events, err
}

func decodeCursor(cur sentinelconnector.Cursor) cursorState {
	if len(cur) == 0 {
		return cursorState{}
	}
	var state cursorState
	_ = json.Unmarshal(cur, &state)
	return state
}

// Normalise wires this connector to MapEvent (ocsf_mapping.go).
func (c *Connector) Normalise(raw sentinelconnector.RawEvent) ([]ocsf.Event, error) {
	return []ocsf.Event{MapEvent(raw.TenantID, Stream, raw.Payload, raw.FetchedAt)}, nil
}

// HealthCheck proves the connector can still reach the Event Hub —
// fetching properties is a cheap, side-effect-free call that fails the
// same way a real receive would if the connection string's SAS token
// were revoked or expired.
func (c *Connector) HealthCheck(ctx context.Context) error {
	_, err := c.client.GetEventHubProperties(ctx, nil)
	return err
}
