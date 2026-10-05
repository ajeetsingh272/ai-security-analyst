package sentinelconnector

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
)

// marshalEvent turns a normalised event into wire bytes. JSON, not because
// it's the final answer for the real Redpanda producer — protobuf vs JSON is
// explicitly P1-05's decision (see Publisher's own doc comment) — but
// because the scheduler needs SOME concrete bytes to hand InMemoryPublisher
// in P1-01's own tests, and JSON is the form that needs no schema-compiler
// step to exist yet.
func marshalEvent(ev ocsf.Event) ([]byte, error) {
	return json.Marshal(ev)
}

// Publisher durably writes a batch of normalised events to the stream and
// returns once the write is acknowledged — the "Kafka ack" ADR-0010's
// checkpointing contract is built around. This is the seam P1-05's real
// Redpanda producer plugs into (topic/partition/key strategy per ADR-0003);
// P1-01 only needs the abstraction and a fake for testing the scheduler's
// orchestration logic in isolation from any real broker.
//
// Publish must not return successfully until the write is durable — the
// scheduler commits the cursor immediately after Publish returns, trusting
// that return as the ack.
type Publisher interface {
	Publish(ctx context.Context, tenantID string, events []EventEnvelope) error
}

// EventEnvelope is what actually goes on the wire — the normalised OCSF
// event plus the routing/ordering key a real producer needs (ADR-0003: keyed
// by tenant_id, with a reserved shard suffix). Kept as raw bytes here rather
// than the ocsf.Event struct directly, since P1-01 doesn't own the wire
// serialisation format (protobuf vs JSON is P1-05's decision) — the
// scheduler marshals once, and both Publisher implementations (real and
// fake) see the same bytes a real broker would.
type EventEnvelope struct {
	TenantID string
	Payload  []byte
}

// InMemoryPublisher is a test double: it durably "publishes" into memory and
// never fails, unless told to via FailNext. Exists so P1-01's scheduler
// tests exercise real orchestration logic (cursor advances only after
// Publish returns, cursor does NOT advance if Publish errors) without a
// running Redpanda broker.
type InMemoryPublisher struct {
	mu        sync.Mutex
	published map[string][]EventEnvelope // tenantID -> everything ever published
	failNext  bool
}

func NewInMemoryPublisher() *InMemoryPublisher {
	return &InMemoryPublisher{published: make(map[string][]EventEnvelope)}
}

func (p *InMemoryPublisher) Publish(_ context.Context, tenantID string, events []EventEnvelope) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failNext {
		p.failNext = false
		return errPublishFailed
	}
	p.published[tenantID] = append(p.published[tenantID], events...)
	return nil
}

// FailNext makes the NEXT call to Publish return an error instead of
// succeeding — P1-01 T2 needs to prove a publish failure does not advance
// the cursor, which requires a publisher that can fail on command.
func (p *InMemoryPublisher) FailNext() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.failNext = true
}

// Published returns everything successfully published for tenantID, for
// test assertions.
func (p *InMemoryPublisher) Published(tenantID string) []EventEnvelope {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]EventEnvelope, len(p.published[tenantID]))
	copy(out, p.published[tenantID])
	return out
}

type publishError struct{ msg string }

func (e *publishError) Error() string { return e.msg }

var errPublishFailed = &publishError{msg: "sentinelconnector: publish failed (InMemoryPublisher.FailNext was armed)"}
