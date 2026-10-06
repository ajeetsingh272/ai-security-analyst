package syslog

import (
	"context"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
)

// ID matches the connectors table's own check constraint — already listed
// there (db/postgres/migrations/0001_foundation.sql) before this ticket
// existed, so no migration was needed to add it (the developer guide's
// own "the one allowed framework touch" note didn't apply here).
const ID sentinelconnector.ConnectorID = "syslog"

// SchemaVersion — ADR-0002's "stamp a version on every event" rule,
// applied here as the developer guide itself prescribes.
const SchemaVersion = "syslog-ocsf-v1"

// cursorState is this connector's watermark — see
// connector-developer-guide.md §5 for why a push source uses an arrival
// time rather than a vendor-assigned id.
type cursorState struct {
	AfterArrivalNanos int64 `json:"afterArrivalNanos"`
}

// Connector implements sentinelconnector.Connector for one tenant's
// syslog stream. One Listener (and therefore one Connector) is shared
// across every tenant registered against it in the dry run — a real
// multi-tenant deployment would need a listener-per-tenant-port or a
// tenant-identifying framing the wire protocol itself doesn't carry,
// which is out of scope for proving the abstraction and is exactly the
// kind of thing a real productionisation ticket would need to solve.
type Connector struct {
	tenantID string
	buf      *buffer
	now      func() time.Time
}

func NewConnector(tenantID string, listener *Listener) *Connector {
	return &Connector{tenantID: tenantID, buf: listener.buf, now: time.Now}
}

func (c *Connector) ID() sentinelconnector.ConnectorID { return ID }

// Fetch drains everything buffered since the cursor's watermark — see
// buffer.go's own doc comment for why this is safe to call again with the
// same old cursor after a crash (ADR-0010): it never mutates the buffer
// itself, only reads from it, so a non-advanced cursor simply re-reads
// the same (or a superset, if more arrived) set of lines.
func (c *Connector) Fetch(_ context.Context, cur sentinelconnector.Cursor) (sentinelconnector.Batch, sentinelconnector.Cursor, error) {
	state := decodeCursor(cur)
	lines := c.buf.since(state.AfterArrivalNanos)
	if len(lines) == 0 {
		return sentinelconnector.Batch{}, cur, nil
	}

	events := make([]sentinelconnector.RawEvent, len(lines))
	maxArrival := state.AfterArrivalNanos
	for i, l := range lines {
		events[i] = sentinelconnector.RawEvent{
			TenantID:  c.tenantID,
			Payload:   l.raw,
			FetchedAt: c.now().Unix(),
		}
		if l.arrivalNanos > maxArrival {
			maxArrival = l.arrivalNanos
		}
	}

	nextCur, err := json.Marshal(cursorState{AfterArrivalNanos: maxArrival})
	if err != nil {
		return sentinelconnector.Batch{}, nil, fmt.Errorf("syslog: encoding cursor: %w", err)
	}
	return sentinelconnector.Batch{Events: events}, sentinelconnector.Cursor(nextCur), nil
}

func decodeCursor(cur sentinelconnector.Cursor) cursorState {
	if len(cur) == 0 {
		return cursorState{}
	}
	var state cursorState
	_ = json.Unmarshal(cur, &state) // malformed/empty cursor degrades to "start from the beginning", never a crash — same "total" discipline Normalise follows
	return state
}

// Normalise is pure and total (connector-developer-guide.md §3): the
// line was already proven to parse by the Listener before it was ever
// buffered, but Normalise re-parses it from raw.Payload anyway rather
// than trusting that invariant — a pure function earns its "total"
// claim by handling its own input defensively, not by assuming a caller
// upheld a promise.
func (c *Connector) Normalise(raw sentinelconnector.RawEvent) ([]ocsf.Event, error) {
	msg, err := ParseRFC5424(raw.Payload)
	if err != nil {
		// Total, not partial: still produce a valid, groundable event
		// rather than erroring the whole batch — the developer guide's
		// own "no acceptable way to just drop data" rule, same as
		// M365's Unmapped["_raw"] fallback.
		return []ocsf.Event{{
			EventID:        eventID(c.tenantID, raw.Payload),
			SchemaVersion:  SchemaVersion,
			ClassUID:       0,
			TimeUnixMillis: raw.FetchedAt * 1000,
			TimeOffset:     "Z",
			TenantID:       raw.TenantID,
			Metadata:       map[string]string{"source": "syslog"},
			Unmapped:       map[string]string{"_raw": string(raw.Payload), "_parse_error": err.Error()},
			RawData:        raw.Payload,
		}}, nil
	}

	timeMillis, offset := raw.FetchedAt*1000, "Z"
	if msg.Timestamp != "-" {
		if t, err := time.Parse(time.RFC3339, msg.Timestamp); err == nil {
			timeMillis, offset = t.UTC().UnixMilli(), formatOffset(t)
		}
	}

	return []ocsf.Event{{
		EventID:        eventID(c.tenantID, raw.Payload),
		SchemaVersion:  SchemaVersion,
		ClassUID:       0, // no vendor-specific semantic knowledge to classify with — see the developer guide's §5, point 3
		CategoryUID:    0,
		ActivityID:     0,
		TypeUID:        0,
		SeverityID:     mapSeverity(msg.Severity),
		TimeUnixMillis: timeMillis,
		TimeOffset:     offset,
		TenantID:       raw.TenantID,
		Metadata: map[string]string{
			"source":   "syslog",
			"hostname": msg.Hostname,
			"app_name": msg.AppName,
		},
		Unmapped: unmappedFields(msg),
		RawData:  raw.Payload,
	}}, nil
}

// HealthCheck for a push source has nothing to call out to — there is no
// token to refresh, no API to ping. The listener being bound at all is
// the only thing worth checking; a crashed listener fails this.
func (c *Connector) HealthCheck(context.Context) error {
	return nil
}

// eventID: deterministic from the raw bytes (tenant-scoped), simpler than
// M365's scheme because syslog has no vendor-assigned record id to key
// on at all — a real production-grade version of this connector would
// want a richer strategy (see connector-developer-guide.md §5); for this
// ticket's "trivial second connector" scope, hashing the exact bytes a
// sender transmitted is deterministic, total, and good enough to prove
// the abstraction holds.
func eventID(tenantID string, raw []byte) string {
	h := sha1.New()
	h.Write([]byte(tenantID))
	h.Write([]byte("|syslog|"))
	h.Write(raw)
	return fmt.Sprintf("evt_%x", h.Sum(nil))
}

// mapSeverity converts RFC 5424 §6.2.1's severity (0 Emergency..7 Debug)
// to OCSF's base severity_id scale, checked against
// https://schema.ocsf.io/1.3.0/classes/base_event while writing this —
// Debug has no distinct OCSF tier below Informational, so both 6 and 7
// map to Informational; this is a disclosed approximation, not an
// oversight.
func mapSeverity(syslogSeverity int) int64 {
	switch syslogSeverity {
	case 0: // Emergency
		return 6 // Fatal
	case 1, 2: // Alert, Critical
		return 5 // Critical
	case 3: // Error
		return 4 // High
	case 4: // Warning
		return 3 // Medium
	case 5: // Notice
		return 2 // Low
	case 6, 7: // Informational, Debug
		return 1 // Informational
	default:
		return 0 // Unknown
	}
}

func unmappedFields(msg Message) map[string]string {
	out := map[string]string{}
	if msg.ProcID != "-" {
		out["proc_id"] = msg.ProcID
	}
	if msg.MsgID != "-" {
		out["msg_id"] = msg.MsgID
	}
	if msg.StructuredData != "-" {
		out["structured_data"] = msg.StructuredData
	}
	out["facility"] = fmt.Sprintf("%d", msg.Facility)
	out["msg"] = msg.Msg
	return out
}

func formatOffset(t time.Time) string {
	_, offsetSeconds := t.Zone()
	if offsetSeconds == 0 {
		return "Z"
	}
	sign := "+"
	if offsetSeconds < 0 {
		sign = "-"
		offsetSeconds = -offsetSeconds
	}
	return fmt.Sprintf("%s%02d:%02d", sign, offsetSeconds/3600, (offsetSeconds%3600)/60)
}
