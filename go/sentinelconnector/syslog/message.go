// Package syslog is P1-13's dry run: a trivial second connector, built
// against docs/architecture/connector-developer-guide.md ALONE — no peeking
// at go/sentinelconnector/m365's own internals beyond what that guide
// documents or links to. Its whole point is to prove the Connector
// abstraction (go/sentinelconnector) actually abstracts: adding this source
// required no change to that package, to go/sentinelstream, to
// go/sentineldb, or to services/detect/correlate — only a new package plus
// one Register call at services/ingest's composition root.
package syslog

import (
	"bytes"
	"fmt"
	"strconv"
)

// Message is one parsed RFC 5424 syslog entry —
// https://datatracker.ietf.org/doc/html/rfc5424#section-6.
//
// <PRI>VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP STRUCTURED-DATA [SP MSG]
type Message struct {
	Facility       int
	Severity       int // RFC 5424 §6.2.1: 0 (Emergency) .. 7 (Debug)
	Version        string
	Timestamp      string // RFC3339, or "-" (nil value) per the RFC
	Hostname       string
	AppName        string
	ProcID         string
	MsgID          string
	StructuredData string // "-", or the raw "[...]"-bracketed SD-ELEMENT(s) verbatim
	Msg            string
}

const nilValue = "-"

// ParseRFC5424 is this connector's entire parsing surface — pure, and used
// both by the listener (to decide whether to buffer a line at all) and by
// Normalise (connector.go), matching the developer guide's own "Normalise
// must be pure and total" rule: parsing itself has no I/O either, so there
// is nothing impure for Normalise to accidentally inherit.
//
// This is a pragmatic subset of RFC 5424, not a conformance-tested
// implementation: it does not validate STRUCTURED-DATA's internal
// SD-PARAM escaping rules, and it treats anything after STRUCTURED-DATA as
// MSG verbatim rather than distinguishing a BOM-prefixed UTF-8 MSG from a
// non-UTF-8 one. Appropriate for this ticket's "trivial second connector"
// scope (connector-developer-guide.md's own framing) — a production
// syslog receiver would need a conformance-tested parser, which is exactly
// the kind of gap that guide's "friction found" section flags rather than
// quietly papering over.
func ParseRFC5424(line []byte) (Message, error) {
	if len(line) == 0 || line[0] != '<' {
		return Message{}, fmt.Errorf("syslog: line does not start with '<PRI>': %q", truncate(line))
	}
	closeIdx := bytes.IndexByte(line, '>')
	if closeIdx < 1 {
		return Message{}, fmt.Errorf("syslog: no closing '>' for PRI: %q", truncate(line))
	}
	prival, err := strconv.Atoi(string(line[1:closeIdx]))
	if err != nil || prival < 0 || prival > 191 {
		return Message{}, fmt.Errorf("syslog: invalid PRI value %q: %w", line[1:closeIdx], err)
	}

	rest := line[closeIdx+1:]
	fields, msg, err := splitHeaderFields(rest, 6)
	if err != nil {
		return Message{}, err
	}

	sd, msg, err := splitStructuredData(msg)
	if err != nil {
		return Message{}, err
	}

	return Message{
		Facility:       prival / 8,
		Severity:       prival % 8,
		Version:        string(fields[0]),
		Timestamp:      string(fields[1]),
		Hostname:       string(fields[2]),
		AppName:        string(fields[3]),
		ProcID:         string(fields[4]),
		MsgID:          string(fields[5]),
		StructuredData: sd,
		Msg:            string(bytes.TrimSpace(msg)),
	}, nil
}

// splitHeaderFields splits off exactly n space-delimited fields
// (VERSION, TIMESTAMP, HOSTNAME, APP-NAME, PROCID, MSGID), returning
// whatever's left (STRUCTURED-DATA + MSG) unconsumed.
func splitHeaderFields(rest []byte, n int) ([][]byte, []byte, error) {
	rest = bytes.TrimPrefix(rest, []byte(" "))
	fields := make([][]byte, 0, n)
	for i := 0; i < n; i++ {
		sp := bytes.IndexByte(rest, ' ')
		if sp < 0 {
			return nil, nil, fmt.Errorf("syslog: expected %d header fields, ran out after %d", n, len(fields))
		}
		fields = append(fields, rest[:sp])
		rest = rest[sp+1:]
	}
	return fields, rest, nil
}

// splitStructuredData returns STRUCTURED-DATA verbatim ("-" or one or more
// "[...]" elements) and whatever follows as MSG.
func splitStructuredData(rest []byte) (sd string, msg []byte, err error) {
	if len(rest) > 0 && rest[0] == '-' {
		return nilValue, rest[1:], nil
	}
	start := 0
	for start < len(rest) && rest[start] == '[' {
		depth := 0
		i := start
		for ; i < len(rest); i++ {
			switch rest[i] {
			case '[':
				depth++
			case ']':
				depth--
				if depth == 0 {
					i++
					goto nextElement
				}
			}
		}
		return "", nil, fmt.Errorf("syslog: unterminated STRUCTURED-DATA element starting at byte %d", start)
	nextElement:
		start = i
	}
	if start == 0 {
		return "", nil, fmt.Errorf("syslog: STRUCTURED-DATA must be '-' or start with '[', got %q", truncate(rest))
	}
	return string(rest[:start]), rest[start:], nil
}

func truncate(b []byte) string {
	const max = 80
	if len(b) <= max {
		return string(b)
	}
	return string(b[:max]) + "..."
}
