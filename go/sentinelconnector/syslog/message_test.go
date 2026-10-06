package syslog

import "testing"

// RFC 5424 §6.5's own example 1 (https://datatracker.ietf.org/doc/html/rfc5424#section-6.5),
// minus the literal UTF-8 BOM byte sequence before MSG (not reproducible in
// a plain Go string literal without obscuring the test) — otherwise
// verbatim.
func TestParseRFC5424_SpecExample(t *testing.T) {
	line := []byte(`<34>1 2003-10-11T22:14:15.003Z mymachine.example.com su - ID47 - 'su root' failed for lonvick on /dev/pts/8`)
	msg, err := ParseRFC5424(line)
	if err != nil {
		t.Fatalf("ParseRFC5424: %v", err)
	}
	if msg.Facility != 4 {
		t.Errorf("Facility = %d, want 4", msg.Facility)
	}
	if msg.Severity != 2 {
		t.Errorf("Severity = %d, want 2", msg.Severity)
	}
	if msg.Version != "1" {
		t.Errorf("Version = %q, want %q", msg.Version, "1")
	}
	if msg.Timestamp != "2003-10-11T22:14:15.003Z" {
		t.Errorf("Timestamp = %q", msg.Timestamp)
	}
	if msg.Hostname != "mymachine.example.com" {
		t.Errorf("Hostname = %q", msg.Hostname)
	}
	if msg.AppName != "su" {
		t.Errorf("AppName = %q", msg.AppName)
	}
	if msg.ProcID != "-" {
		t.Errorf("ProcID = %q, want nil value", msg.ProcID)
	}
	if msg.MsgID != "ID47" {
		t.Errorf("MsgID = %q", msg.MsgID)
	}
	if msg.StructuredData != "-" {
		t.Errorf("StructuredData = %q, want nil value", msg.StructuredData)
	}
	if msg.Msg != "'su root' failed for lonvick on /dev/pts/8" {
		t.Errorf("Msg = %q", msg.Msg)
	}
}

// RFC 5424 §6.5's example 3 — a real STRUCTURED-DATA element.
func TestParseRFC5424_StructuredData(t *testing.T) {
	line := []byte(`<165>1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog - ID47 [exampleSDID@32473 iut="3" eventSource="Application" eventID="1011"] An application event log entry`)
	msg, err := ParseRFC5424(line)
	if err != nil {
		t.Fatalf("ParseRFC5424: %v", err)
	}
	wantSD := `[exampleSDID@32473 iut="3" eventSource="Application" eventID="1011"]`
	if msg.StructuredData != wantSD {
		t.Errorf("StructuredData = %q, want %q", msg.StructuredData, wantSD)
	}
	if msg.Msg != "An application event log entry" {
		t.Errorf("Msg = %q", msg.Msg)
	}
	if msg.Facility != 20 { // 165/8
		t.Errorf("Facility = %d, want 20", msg.Facility)
	}
	if msg.Severity != 5 { // 165%8
		t.Errorf("Severity = %d, want 5", msg.Severity)
	}
}

// Two STRUCTURED-DATA elements back to back.
func TestParseRFC5424_MultipleStructuredDataElements(t *testing.T) {
	line := []byte(`<14>1 2024-01-01T00:00:00Z host app 123 - [a@1 x="1"][b@2 y="2"] hello`)
	msg, err := ParseRFC5424(line)
	if err != nil {
		t.Fatalf("ParseRFC5424: %v", err)
	}
	if msg.StructuredData != `[a@1 x="1"][b@2 y="2"]` {
		t.Errorf("StructuredData = %q", msg.StructuredData)
	}
	if msg.Msg != "hello" {
		t.Errorf("Msg = %q", msg.Msg)
	}
	if msg.ProcID != "123" {
		t.Errorf("ProcID = %q", msg.ProcID)
	}
}

// A message with no MSG at all — RFC 5424 says MSG is optional.
func TestParseRFC5424_NoMessage(t *testing.T) {
	line := []byte(`<14>1 2024-01-01T00:00:00Z host app - - -`)
	msg, err := ParseRFC5424(line)
	if err != nil {
		t.Fatalf("ParseRFC5424: %v", err)
	}
	if msg.Msg != "" {
		t.Errorf("Msg = %q, want empty", msg.Msg)
	}
}

func TestParseRFC5424_RejectsMalformedInput(t *testing.T) {
	cases := []string{
		"",
		"not a syslog line at all",
		"<not-a-number>1 ...",
		"<34",                                 // no closing '>'
		"<34>1 2024-01-01T00:00:00Z host app", // too few header fields
		"<34>1 2024-01-01T00:00:00Z host app 1 2 nope", // STRUCTURED-DATA must be '-' or '[...'
	}
	for _, line := range cases {
		if _, err := ParseRFC5424([]byte(line)); err == nil {
			t.Errorf("ParseRFC5424(%q): expected an error, got none", line)
		}
	}
}
