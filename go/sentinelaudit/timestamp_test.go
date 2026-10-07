package sentinelaudit

import (
	"testing"
	"time"
)

// occurredAtFormat (defined in writer.go) is what writeEntry actually
// uses — tested directly here, not only through a real Postgres round
// trip, because occurredAt is a HASHED field: see writer.go's own doc
// comment for why a naive time.RFC3339Nano would silently diverge
// from JS's own `Date.toISOString()`.
func TestOccurredAtFormat_MatchesJSToISOStringForRoundSecond(t *testing.T) {
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	got := ts.Format(occurredAtFormat)
	want := "2026-01-01T00:00:00.000Z" // new Date(Date.UTC(2026,0,1)).toISOString()
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestOccurredAtFormat_MatchesJSToISOStringForSubSecondValue(t *testing.T) {
	ts := time.Date(2026, 1, 1, 12, 30, 45, 123000000, time.UTC) // .123 seconds
	got := ts.Format(occurredAtFormat)
	want := "2026-01-01T12:30:45.123Z"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestOccurredAtFormat_TruncatesSubMillisecondPrecision(t *testing.T) {
	// Go's time.Time has nanosecond precision; JS's Date only ever has
	// millisecond precision. Sub-millisecond bits must be truncated,
	// not rounded, matching how the first 3 digits of a stored
	// microsecond-precision TIMESTAMPTZ value would re-format
	// identically regardless of what the 4th-6th digits are.
	ts := time.Date(2026, 1, 1, 0, 0, 0, 123456789, time.UTC)
	got := ts.Format(occurredAtFormat)
	want := "2026-01-01T00:00:00.123Z"
	if got != want {
		t.Errorf("got %q, want %q (sub-millisecond bits must not round up)", got, want)
	}
}
