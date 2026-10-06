package syslog

import "sync"

// bufferedLine is one raw line, stamped with its arrival time — the
// watermark this connector's Cursor is built from (connector.go, cursor.go),
// since a push source has no vendor-assigned checkpoint to resume from at
// all (connector-developer-guide.md §5's own "friction found" note).
type bufferedLine struct {
	raw          []byte
	arrivalNanos int64
}

// buffer is a thread-safe, in-memory, unbounded receive queue — unbounded
// deliberately disclosed as a gap in the developer guide (§5, point 2:
// the token-bucket backpressure overview.md §3.1 describes for push
// sources isn't built anywhere yet), not a silent omission here.
type buffer struct {
	mu    sync.Mutex
	lines []bufferedLine
}

func newBuffer() *buffer {
	return &buffer{}
}

// append adds one line, stamped with now (injectable for tests that need
// to control ordering precisely).
func (b *buffer) append(raw []byte, arrivalNanos int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	// Copy — the caller (the listener's read loop) reuses its read buffer
	// across lines.
	cp := make([]byte, len(raw))
	copy(cp, raw)
	b.lines = append(b.lines, bufferedLine{raw: cp, arrivalNanos: arrivalNanos})
}

// since returns every buffered line with arrivalNanos strictly greater
// than afterNanos, oldest first — Fetch's entire read path (connector.go).
// Does NOT remove anything from the buffer itself; the Cursor the caller
// commits afterwards is what prevents re-delivery on the NEXT Fetch call,
// matching every other connector's "Fetch doesn't mutate its own source of
// truth, the committed cursor is what advances" discipline.
func (b *buffer) since(afterNanos int64) []bufferedLine {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]bufferedLine, 0, len(b.lines))
	for _, l := range b.lines {
		if l.arrivalNanos > afterNanos {
			out = append(out, l)
		}
	}
	return out
}

// len reports the current buffer size — used only by HealthCheck/tests,
// never by Fetch's own read path.
func (b *buffer) len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.lines)
}
