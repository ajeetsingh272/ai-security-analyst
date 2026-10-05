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
}

// NewRedpandaPublisher wraps an already-configured client. Client
// construction (brokers, idempotence, TLS/SASL if ever needed) is the
// caller's concern — this type is deliberately narrow, matching
// go/sentinelobs and go/sentineldb's pattern of taking a ready-made handle
// rather than owning connection setup.
func NewRedpandaPublisher(client *kgo.Client, topic string) *RedpandaPublisher {
	return &RedpandaPublisher{client: client, topic: topic}
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

	records := make([]*kgo.Record, len(events))
	key := TenantKey(tenantID)
	for i, ev := range events {
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
