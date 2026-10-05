package sentinelevents

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/ClickHouse/clickhouse-go/v2"
)

const insertSQL = `INSERT INTO sentinel.events
	(tenant_id, event_id, time, class_uid, category_uid, activity_id, type_uid, severity_id,
	 actor_user_uid, actor_user_name, actor_user_email, status_id, message, unmapped, raw_ref, trace_id)`

// Writer durably writes a batch of rows to sentinel.events, returning only
// once ClickHouse has acknowledged the write — the Consumer commits Kafka
// offsets immediately after this returns, trusting that return the same
// way P1-01's scheduler trusts Publisher.Publish's return (ADR-0010's
// pattern, applied here to ClickHouse instead of Kafka).
type Writer interface {
	Write(ctx context.Context, rows []EventRow) error
}

// ClickHouseWriter is the real implementation. async_insert +
// wait_for_async_insert (ADR-0005's "async insert mode") are set
// connection-wide in NewClickHouseWriter rather than per-query: they
// combine concurrent inserts server-side into fewer, larger parts — good
// for merge health — while wait_for_async_insert=1 is what keeps this
// call blocking until the data is actually durable, which AC2 depends on.
// Without wait_for_async_insert, async_insert alone would let Write return
// before the data is flushed, and a commit right after would be a false
// ack — exactly the ordering bug ADR-0010 exists to prevent on the Kafka
// side; the same discipline applies here.
type ClickHouseWriter struct {
	conn         clickhouse.Conn
	log          *slog.Logger
	onInvalidRow func(row EventRow, err error)
}

func NewClickHouseWriter(addr, database, username, password string) (*ClickHouseWriter, error) {
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr: []string{addr},
		Auth: clickhouse.Auth{
			Database: database,
			Username: username,
			Password: password,
		},
		Settings: clickhouse.Settings{
			"async_insert":          1,
			"wait_for_async_insert": 1,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("sentinelevents: opening ClickHouse connection: %w", err)
	}
	return &ClickHouseWriter{conn: conn, log: slog.Default()}, nil
}

func (w *ClickHouseWriter) Close() error { return w.conn.Close() }

// OnInvalidRow, if set, is called for every row ClickHouse rejects for a
// data reason (a malformed field — the thing that caused this method to
// exist, see the commit message) rather than a connectivity one. Exists so
// a caller can route rejected rows to the events.normalized.dlq topic
// P1-05 already provisions; this package doesn't do that publish itself —
// it only guarantees a bad row can never again block every row behind it,
// which is the part that was actually broken.
func (w *ClickHouseWriter) OnInvalidRow(fn func(row EventRow, err error)) {
	w.onInvalidRow = fn
}

// Write issues one batched INSERT per attempt — AC1, "batched inserts
// only, never per-row". PrepareBatch/Append/Send is one native-protocol
// statement regardless of how many rows are in it; a loop of single-row
// Exec calls is the thing this type exists specifically to never do.
//
// A row ClickHouse rejects for a DATA reason (not found empirically by
// reading the docs, but by running P1-07's own load test: a single
// non-UUID tenant_id made every retry of the whole batch fail identically,
// forever — the same batch, the same bad row, every cycle, blocking every
// OTHER tenant's events behind it indefinitely) is dropped and the rest of
// the batch is retried without it, rather than the whole batch failing
// repeatedly. A connectivity-level failure (ClickHouse unreachable) is NOT
// swallowed this way — Send's error surfaces normally, and the Consumer's
// existing retry-without-committing path (T2) handles that case correctly
// already.
func (w *ClickHouseWriter) Write(ctx context.Context, rows []EventRow) error {
	remaining := rows
	for len(remaining) > 0 {
		batch, err := w.conn.PrepareBatch(ctx, insertSQL)
		if err != nil {
			return fmt.Errorf("sentinelevents: preparing batch: %w", err)
		}

		badIdx := -1
		var appendErr error
		for i, r := range remaining {
			if err := batch.Append(
				r.TenantID, r.EventID, r.Time, r.ClassUID, r.CategoryUID, r.ActivityID, r.TypeUID, r.SeverityID,
				r.ActorUserUID, r.ActorUserName, r.ActorUserEmail, r.StatusID, r.Message, r.Unmapped, r.RawRef, r.TraceID,
			); err != nil {
				badIdx, appendErr = i, err
				break
			}
		}

		if badIdx == -1 {
			if err := batch.Send(); err != nil {
				return fmt.Errorf("sentinelevents: sending batch of %d rows: %w", len(remaining), err)
			}
			return nil
		}

		_ = batch.Abort()
		bad := remaining[badIdx]
		w.log.Error("dropping row ClickHouse rejected (not retried — same data would fail again)",
			"event_id", bad.EventID, "tenant_id", bad.TenantID, "err", appendErr)
		if w.onInvalidRow != nil {
			w.onInvalidRow(bad, appendErr)
		}
		remaining = append(append([]EventRow{}, remaining[:badIdx]...), remaining[badIdx+1:]...)
	}
	return nil
}
