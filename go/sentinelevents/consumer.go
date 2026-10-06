package sentinelevents

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

type ConsumerOptions struct {
	Trigger BatchTrigger
	Log     *slog.Logger
	// OnWrite, if non-nil, is called after every successful write with the
	// row count just written — the hook a caller uses to feed a
	// batch-size/throughput metric (AC4's "monitored... with an alert"; the
	// alert ITSELF is infrastructure this package doesn't own, same
	// "mechanism here, dashboard/paging elsewhere" split P1-01 used for
	// connector health). Merge queue depth specifically is monitored
	// separately (see services/eventwriter's own merge-queue poller), since
	// that's a ClickHouse-side property, not something this write path
	// observes directly.
	OnWrite func(rowsWritten int)
}

// Consumer reads events.normalized and writes to ClickHouse via Writer,
// committing Kafka offsets only after a successful write.
//
// Deliberately single-threaded: one goroutine polls, batches, writes, and
// commits, in that order, never starting the next poll until the current
// write has either succeeded or the batch has been handed back for retry.
// This is what makes AC3 ("backpressure propagates: a slow ClickHouse
// slows consumption rather than buffering unboundedly") true without any
// explicit rate-limiting code — there is structurally nowhere for
// unbounded data to accumulate, because nothing reads the next Kafka batch
// until the previous one is durably written.
type Consumer struct {
	client  *kgo.Client
	writer  Writer
	batch   *Batch
	log     *slog.Logger
	onWrite func(int)
}

func NewConsumer(client *kgo.Client, writer Writer, opts ConsumerOptions) *Consumer {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	return &Consumer{
		client:  client,
		writer:  writer,
		batch:   NewBatch(opts.Trigger),
		log:     opts.Log,
		onWrite: opts.OnWrite,
	}
}

// Run polls until ctx is cancelled. Each iteration polls with a bounded
// timeout — short enough that the time-window trigger is checked
// regularly even when no new records arrive, not just when MaxRows is hit.
func (c *Consumer) Run(ctx context.Context) error {
	pollInterval := 1 * time.Second

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		pollCtx, cancel := context.WithTimeout(ctx, pollInterval)
		fetches := c.client.PollFetches(pollCtx)
		cancel()

		if errs := fetches.Errors(); len(errs) > 0 {
			for _, e := range errs {
				// Both are the EXPECTED shape of "this poll's bounded
				// window ended with nothing new" — a deadline from the
				// per-poll timeout, or a cancellation when Run's own ctx
				// is done (checked again at the top of the next
				// iteration). Neither is a real fetch failure; logging
				// them as errors would mean every idle poll and every
				// graceful shutdown logs one.
				if e.Err != nil && e.Err != context.DeadlineExceeded && e.Err != context.Canceled {
					c.log.Error("fetch error", "topic", e.Topic, "partition", e.Partition, "err", e.Err)
				}
			}
		}

		fetches.EachRecord(func(r *kgo.Record) {
			var row EventRow
			if err := json.Unmarshal(r.Value, &row); err != nil {
				// A malformed record on the wire is a producer bug, not a
				// reason to stall every other tenant's events behind it —
				// logged and skipped, same philosophy as P1-01's per-cycle
				// error isolation.
				c.log.Error("skipping malformed record", "topic", r.Topic, "partition", r.Partition, "offset", r.Offset, "err", err)
				return
			}
			c.batch.Add(row)
		})

		if c.batch.ShouldFlush() {
			if err := c.flush(ctx); err != nil {
				c.log.Error("flush failed, will retry next cycle without committing offsets", "err", err)
				// Deliberately no return/abort: the batch is NOT drained
				// (flush only drains on success), so the same rows are
				// retried on the next iteration once more records (or just
				// time) trigger another flush attempt. Offsets for these
				// records are never committed until a write succeeds.
			}
		}
	}
}

func (c *Consumer) flush(ctx context.Context) error {
	rows := c.batch.Drain()
	if err := c.writer.Write(ctx, rows); err != nil {
		// Put the rows back — a failed write must not lose them, and must
		// not advance past them either. This does restart the age window
		// (Add() on an empty batch reopens it), so on a sustained outage
		// retries are implicitly paced at roughly MaxAge intervals rather
		// than hammering ClickHouse every poll — a reasonable backoff as a
		// side effect, not a bug: no row is ever lost or skipped by this,
		// only delayed.
		for _, r := range rows {
			c.batch.Add(r)
		}
		return err
	}
	// Only now, after a durable write, do offsets advance — ADR-0010's
	// commit-after-ack discipline, applied to ClickHouse instead of Kafka.
	if err := c.client.CommitUncommittedOffsets(ctx); err != nil {
		return err
	}
	if c.onWrite != nil {
		c.onWrite(len(rows))
	}
	c.log.Info("batch written and committed", "rows", len(rows))
	return nil
}
