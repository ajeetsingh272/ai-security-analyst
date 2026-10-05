// Package sentinelevents is P1-07: a Kafka consumer that reads normalised
// events and writes them to ClickHouse in batches sized for merge health,
// committing offsets only after a durable write (ADR-0005's own risk
// table: "Batched inserts (never per-row), async insert mode, monitored
// merge queue depth with an alert").
package sentinelevents

import "time"

// EventRow is one row as it will be inserted into sentinel.events — a
// direct mapping of db/clickhouse/0001_events.sql's columns, and also the
// wire format this package's Consumer expects on the events.normalized
// topic (JSON-tagged for exactly that reason). Nothing publishes to that
// topic yet — P1-04 (OCSF normalisation) is what will, once a real
// connector exists (blocked on real OAuth credentials, P1-02) — so this
// IS the contract a future normaliser needs to produce, not a guess at
// one; P1-07 doesn't get to wait for P1-04 to define it first.
type EventRow struct {
	TenantID       string            `json:"tenant_id"`
	EventID        string            `json:"event_id"`
	Time           time.Time         `json:"time"`
	ClassUID       uint32            `json:"class_uid"`
	CategoryUID    uint16            `json:"category_uid"`
	ActivityID     uint16            `json:"activity_id"`
	TypeUID        uint32            `json:"type_uid"`
	SeverityID     uint8             `json:"severity_id"`
	ActorUserUID   string            `json:"actor_user_uid"`
	ActorUserName  string            `json:"actor_user_name"`
	ActorUserEmail string            `json:"actor_user_email"`
	StatusID       uint8             `json:"status_id"`
	Message        string            `json:"message"`
	Unmapped       map[string]string `json:"unmapped,omitempty"`
	RawRef         string            `json:"raw_ref"`
	TraceID        string            `json:"trace_id"`
}

// BatchTrigger decides when an accumulating batch should flush — the AC4
// requirement that sizing "respects both the row-count and time-window
// triggers", whichever fires first. Pure and clock-injectable so T4 can
// prove both triggers without a real ClickHouse or a real wall-clock sleep.
type BatchTrigger struct {
	MaxRows int
	MaxAge  time.Duration
}

// Batch accumulates rows until Trigger fires, per the BatchTrigger rule.
// Not safe for concurrent use — the consumer loop that owns it is
// single-threaded by design (see Consumer's own doc comment on why that is
// what makes backpressure work at all).
type Batch struct {
	trigger  BatchTrigger
	rows     []EventRow
	openedAt time.Time
	now      func() time.Time
}

func NewBatch(trigger BatchTrigger) *Batch {
	return newBatchWithClock(trigger, time.Now)
}

// newBatchWithClock exists so tests can inject a fake clock for the
// time-window trigger without a real sleep — exported indirectly via
// test-only constructors in batch_test.go, not part of the public API.
func newBatchWithClock(trigger BatchTrigger, now func() time.Time) *Batch {
	return &Batch{trigger: trigger, now: now}
}

// Add appends a row, opening the batch's age window on the first row if it
// was empty. Returns whether the batch should now be flushed.
func (b *Batch) Add(row EventRow) (shouldFlush bool) {
	if len(b.rows) == 0 {
		b.openedAt = b.now()
	}
	b.rows = append(b.rows, row)
	return b.ShouldFlush()
}

// ShouldFlush reports whether either trigger has fired — callable
// independently of Add so a consumer loop can also check it on an idle
// poll timeout (nothing new arrived, but the time window still elapsed).
func (b *Batch) ShouldFlush() bool {
	if len(b.rows) == 0 {
		return false
	}
	if len(b.rows) >= b.trigger.MaxRows {
		return true
	}
	return b.now().Sub(b.openedAt) >= b.trigger.MaxAge
}

// Drain returns the accumulated rows and resets the batch for the next
// window. Called only after a successful ClickHouse write — see Consumer's
// offset-commit ordering, the same ADR-0010-style "commit only after ack"
// discipline P1-01 already established for Kafka cursors, applied here to
// ClickHouse instead.
func (b *Batch) Drain() []EventRow {
	rows := b.rows
	b.rows = nil
	return rows
}

func (b *Batch) Len() int { return len(b.rows) }
