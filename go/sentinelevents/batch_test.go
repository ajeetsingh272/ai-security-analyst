package sentinelevents

import (
	"testing"
	"time"
)

func fakeClock(start time.Time) (now func() time.Time, advance func(time.Duration)) {
	t := start
	return func() time.Time { return t },
		func(d time.Duration) { t = t.Add(d) }
}

// T4: batch sizing respects the row-count trigger.
func TestBatchFlushesOnRowCount(t *testing.T) {
	now, _ := fakeClock(time.Unix(0, 0))
	b := newBatchWithClock(BatchTrigger{MaxRows: 3, MaxAge: time.Hour}, now)

	if flush := b.Add(EventRow{EventID: "1"}); flush {
		t.Fatal("expected no flush after 1/3 rows")
	}
	if flush := b.Add(EventRow{EventID: "2"}); flush {
		t.Fatal("expected no flush after 2/3 rows")
	}
	flush := b.Add(EventRow{EventID: "3"})
	if !flush {
		t.Fatal("expected flush at 3/3 rows (MaxRows trigger)")
	}
	if b.Len() != 3 {
		t.Fatalf("expected 3 accumulated rows, got %d", b.Len())
	}
}

// T4: batch sizing respects the time-window trigger, independent of row
// count — a slow trickle of events must still flush eventually rather than
// waiting forever for MaxRows for a tenant with low volume.
func TestBatchFlushesOnTimeWindow(t *testing.T) {
	now, advance := fakeClock(time.Unix(0, 0))
	b := newBatchWithClock(BatchTrigger{MaxRows: 1000, MaxAge: 5 * time.Second}, now)

	if flush := b.Add(EventRow{EventID: "1"}); flush {
		t.Fatal("expected no flush immediately after the first row")
	}

	advance(4 * time.Second)
	if b.ShouldFlush() {
		t.Fatal("expected no flush before MaxAge elapses")
	}

	advance(2 * time.Second) // total 6s > 5s MaxAge
	if !b.ShouldFlush() {
		t.Fatal("expected flush once MaxAge has elapsed, regardless of row count")
	}
}

func TestBatchDrainResetsForNextWindow(t *testing.T) {
	now, _ := fakeClock(time.Unix(0, 0))
	b := newBatchWithClock(BatchTrigger{MaxRows: 2, MaxAge: time.Hour}, now)
	b.Add(EventRow{EventID: "1"})
	b.Add(EventRow{EventID: "2"})

	rows := b.Drain()
	if len(rows) != 2 {
		t.Fatalf("expected 2 drained rows, got %d", len(rows))
	}
	if b.Len() != 0 {
		t.Fatalf("expected batch to be empty after Drain, got %d rows", b.Len())
	}
	if b.ShouldFlush() {
		t.Fatal("an empty batch should never report ready to flush")
	}
}

func TestBatchReopensAgeWindowAfterDrain(t *testing.T) {
	now, advance := fakeClock(time.Unix(0, 0))
	b := newBatchWithClock(BatchTrigger{MaxRows: 1000, MaxAge: 5 * time.Second}, now)

	b.Add(EventRow{EventID: "1"})
	advance(6 * time.Second)
	if !b.ShouldFlush() {
		t.Fatal("expected flush after first window's MaxAge elapsed")
	}
	b.Drain()

	// The NEXT row must start a fresh age window, not inherit the
	// already-elapsed one — otherwise every row after the first flush
	// would flush immediately forever.
	if flush := b.Add(EventRow{EventID: "2"}); flush {
		t.Fatal("expected the age window to reset after Drain, not flush instantly")
	}
}
