//go:build integration

package windowed

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelevents"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelsignal"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
	"github.com/twmb/franz-go/pkg/kgo"
)

const brokers = "localhost:19092"
const clickhouseAddr = "localhost:9000"

func randomUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("generating random uuid: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func newTestWriter(t *testing.T) *sentinelevents.ClickHouseWriter {
	t.Helper()
	w, err := sentinelevents.NewClickHouseWriter(clickhouseAddr, "sentinel", "default", "")
	if err != nil {
		t.Fatalf("connecting to ClickHouse: %v", err)
	}
	t.Cleanup(func() { w.Close() })
	return w
}

func newTestConn(t *testing.T) clickhouse.Conn {
	t.Helper()
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr: []string{clickhouseAddr},
		Auth: clickhouse.Auth{Database: "sentinel", Username: "default"},
	})
	if err != nil {
		t.Fatalf("opening ClickHouse connection: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// signInEvent builds a minimal "UserLoggedIn"/"Success" row, mirroring
// what the real M365 connector now actually persists (go/sentinelconnector
// /m365/ocsf_mapping.go's own Metadata — source/content_type/product/
// operation — plus Unmapped's UserId/ClientIP/ResultStatus) rather than a
// shape this test invented independently.
func signInEvent(tenantID, eventID, userID, clientIP string, at time.Time) sentinelevents.EventRow {
	return sentinelevents.EventRow{
		TenantID: tenantID, EventID: eventID, Time: at,
		SchemaVersion: "1.0", ClassUID: 3002, CategoryUID: 3, ActivityID: 1, TypeUID: 300201, SeverityID: 1,
		Metadata: map[string]string{"source": "m365", "product": "m365", "operation": "UserLoggedIn"},
		Unmapped: map[string]string{"UserId": userID, "ClientIP": clientIP, "ResultStatus": "Success"},
	}
}

func deleteTenantEvents(t *testing.T, conn clickhouse.Conn, tenantID string) {
	t.Helper()
	_ = conn.Exec(context.Background(), "ALTER TABLE sentinel.events DELETE WHERE tenant_id = ?", tenantID)
}

func collectSignals(t *testing.T, tenantID string, n int, timeout time.Duration) []sentinelsignal.Signal {
	t.Helper()
	group := "test-windowed-collect-" + randomUUID(t)
	client, err := kgo.NewClient(
		kgo.SeedBrokers(brokers),
		kgo.ConsumeTopics(sentinelstream.Signals),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
	)
	if err != nil {
		t.Fatalf("creating signals consumer: %v", err)
	}
	defer client.Close()

	var got []sentinelsignal.Signal
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) && len(got) < n {
		ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
		fetches := client.PollFetches(ctx)
		cancel()
		fetches.EachRecord(func(r *kgo.Record) {
			var sig sentinelsignal.Signal
			if err := json.Unmarshal(r.Value, &sig); err != nil {
				return
			}
			if sig.TenantID == tenantID {
				got = append(got, sig)
			}
		})
	}
	return got
}

func runImpossibleTravelOnce(t *testing.T, conn clickhouse.Conn, producer *kgo.Client) {
	t.Helper()
	r := parseRule(t, "impossible-travel")
	sched, err := New([]*sigmac.Rule{r}, conn, producer, Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if len(sched.rules) != 1 {
		t.Fatalf("expected exactly one scheduled rule, got %d", len(sched.rules))
	}
	sched.runOnce(context.Background(), sched.rules[0])
}

// T1: impossible travel fires for a seeded two-country sign-in pair
// inside the velocity threshold — two UserLoggedIn/Success events for the
// SAME UserId from two DIFFERENT ClientIPs, both inside the rule's own
// 10-minute window.
func TestImpossibleTravel_FiresForTwoCountrySignInPair(t *testing.T) {
	tenantID := randomUUID(t)
	userID := "user-" + randomUUID(t)
	writer := newTestWriter(t)
	conn := newTestConn(t)
	t.Cleanup(func() { deleteTenantEvents(t, conn, tenantID) })

	now := time.Now().UTC()
	rows := []sentinelevents.EventRow{
		signInEvent(tenantID, "evt-"+randomUUID(t), userID, "203.0.113.10", now.Add(-5*time.Minute)),
		signInEvent(tenantID, "evt-"+randomUUID(t), userID, "198.51.100.20", now.Add(-1*time.Minute)),
	}
	if err := writer.Write(context.Background(), rows); err != nil {
		t.Fatalf("seeding events: %v", err)
	}

	producer, err := kgo.NewClient(kgo.SeedBrokers(brokers))
	if err != nil {
		t.Fatalf("creating producer: %v", err)
	}
	defer producer.Close()

	runImpossibleTravelOnce(t, conn, producer)

	got := collectSignals(t, tenantID, 1, 15*time.Second)
	if len(got) != 1 {
		t.Fatalf("got %d signals for tenant %s, want exactly 1: %+v", len(got), tenantID, got)
	}
	sig := got[0]
	if sig.RuleID != "8f1a2b3c-0001-4a00-9000-000000000008" {
		t.Errorf("RuleID = %q, want the impossible-travel rule id", sig.RuleID)
	}
	if sig.EntityID != userID {
		t.Errorf("EntityID = %q, want %q", sig.EntityID, userID)
	}
	if len(sig.EventIDs) != 2 {
		t.Errorf("EventIDs = %v, want both contributing sign-ins", sig.EventIDs)
	}
}

// T2: impossible travel does not fire for legitimate VPN-shaped travel —
// the SAME ClientIP across multiple sign-ins (a corporate VPN exit node,
// per the rule's own documented false-positive) never produces more than
// one distinct ClientIP for the user, so count(DISTINCT ClientIP) never
// exceeds the threshold.
func TestImpossibleTravel_DoesNotFireForSameIPTravel(t *testing.T) {
	tenantID := randomUUID(t)
	userID := "user-" + randomUUID(t)
	writer := newTestWriter(t)
	conn := newTestConn(t)
	t.Cleanup(func() { deleteTenantEvents(t, conn, tenantID) })

	now := time.Now().UTC()
	rows := []sentinelevents.EventRow{
		signInEvent(tenantID, "evt-"+randomUUID(t), userID, "203.0.113.10", now.Add(-5*time.Minute)),
		signInEvent(tenantID, "evt-"+randomUUID(t), userID, "203.0.113.10", now.Add(-1*time.Minute)),
	}
	if err := writer.Write(context.Background(), rows); err != nil {
		t.Fatalf("seeding events: %v", err)
	}

	producer, err := kgo.NewClient(kgo.SeedBrokers(brokers))
	if err != nil {
		t.Fatalf("creating producer: %v", err)
	}
	defer producer.Close()

	runImpossibleTravelOnce(t, conn, producer)

	got := collectSignals(t, tenantID, 1, 5*time.Second)
	if len(got) != 0 {
		t.Fatalf("got %d signals for same-IP travel, want 0: %+v", len(got), got)
	}
}
