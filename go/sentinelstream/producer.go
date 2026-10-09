package sentinelstream

import (
	"context"
	"fmt"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
	"github.com/twmb/franz-go/pkg/kgo"
)

// RedpandaPublisher implements sentinelconnector.Publisher (P1-01's seam)
// against a real broker — the thing go/sentinelconnector's own doc comment
// said P1-05 would provide. Batching and idempotent delivery (AC3) are
// kgo.Client defaults, not something this type configures itself: franz-go
// idempotently produces by default (sequenced per partition) unless
// explicitly disabled, and batches automatically by size/linger. This type
// exists to supply the ONE thing the client doesn't know on its own: which
// topic, and how this system's tenant-keyed ordering guarantee (ADR-0003)
// maps onto a kgo.Record's Key.
type RedpandaPublisher struct {
	client *kgo.Client
	topic  string
	// shardController is nil for every existing call site unless
	// explicitly opted into via WithShardController — nil preserves the
	// exact pre-P7-04 behaviour (always TenantKey, shard 0) with zero
	// change, so this field's own addition cannot alter any existing
	// test or production topic's observed keying.
	shardController *ShardController
}

// NewRedpandaPublisher wraps an already-configured client. Client
// construction (brokers, idempotence, TLS/SASL if ever needed) is the
// caller's concern — this type is deliberately narrow, matching
// go/sentinelobs and go/sentineldb's pattern of taking a ready-made handle
// rather than owning connection setup.
func NewRedpandaPublisher(client *kgo.Client, topic string) *RedpandaPublisher {
	return &RedpandaPublisher{client: client, topic: topic}
}

// WithShardController opts this publisher into P7-04's own hot-tenant
// routing (shard.go) — only the services/ingest scheduler's own
// events.normalized publisher needs this; events.raw/DLQ publishers
// stay on today's unconditional shard-0 behaviour deliberately (archival
// and dead-letter paths have no consumer-side noisy-neighbor concern to
// solve). Returns the same *RedpandaPublisher, builder-style, matching
// go/sentinelconnector/aws's own WithVisibilityTimeout precedent.
func (p *RedpandaPublisher) WithShardController(sc *ShardController) *RedpandaPublisher {
	p.shardController = sc
	return p
}

// Publish produces every event, keyed for per-tenant ordering (ADR-0010's
// "durably acknowledged" requirement — P1-01's scheduler commits a cursor
// immediately after this returns, trusting that return as the ack), and
// does not return until every record's produce has actually completed:
// ProduceSync blocks for exactly that reason, rather than this type
// collecting async callbacks itself and risking returning before a write
// the caller is about to treat as durable has actually landed.
func (p *RedpandaPublisher) Publish(ctx context.Context, tenantID string, events []sentinelconnector.EventEnvelope) error {
	if len(events) == 0 {
		return nil
	}

	// Keyed per EVENT, not once for the whole batch: a hot tenant's
	// batch can itself be large (one Fetch cycle's worth of events), and
	// spreading load across shards only works if THIS batch's own
	// records land across multiple partitions, not just batches on
	// different cycles. It's also what makes the EPS measurement
	// shard.go's own ShardController keeps real — counting once per
	// batch would undercount a tenant's true rate by however large its
	// batches are. For a never-sharded tenant (the common case) this is
	// unobservable: TenantKey(tenantID) returns the identical value
	// every time regardless of how often it's called.
	records := make([]*kgo.Record, len(events))
	for i, ev := range events {
		key := TenantKey(tenantID)
		if p.shardController != nil {
			key = p.shardController.KeyFor(ctx, tenantID)
		}
		records[i] = &kgo.Record{
			Topic: p.topic,
			Key:   []byte(key),
			Value: ev.Payload,
		}
	}

	results := p.client.ProduceSync(ctx, records...)
	if err := results.FirstErr(); err != nil {
		return fmt.Errorf("sentinelstream: publishing to %s: %w", p.topic, err)
	}
	return nil
}
