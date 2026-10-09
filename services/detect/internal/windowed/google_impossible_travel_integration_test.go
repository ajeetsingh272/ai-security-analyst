//go:build integration

package windowed

import (
	"context"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelevents"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
	"github.com/twmb/franz-go/pkg/kgo"
)

// T3 (P7-01): "Impossible travel fires correctly on Google sign-in data."
// Mirrors integration_test.go's own TestImpossibleTravel_FiresForTwoCountrySignInPair
// exactly, against impossible-travel-google.yml and Google-shaped rows
// (go/sentinelconnector/google/ocsf_mapping.go's own Metadata/Unmapped
// shape — product=google_workspace, operation=login_success,
// actorEmail/ipAddress) rather than editing that test or its rule, per
// this ticket's own disclosed design choice (see
// detections/rules/impossible-travel-google.yml's own doc comment).
func googleSignInEvent(tenantID, eventID, actorEmail, ipAddress string, at time.Time) sentinelevents.EventRow {
	return sentinelevents.EventRow{
		TenantID: tenantID, EventID: eventID, Time: at,
		SchemaVersion: "google-workspace-ocsf-v1", ClassUID: 3002, CategoryUID: 3, ActivityID: 1, TypeUID: 300201, SeverityID: 1,
		Metadata: map[string]string{"source": "google_workspace", "product": "google_workspace", "operation": "login_success"},
		Unmapped: map[string]string{"actorEmail": actorEmail, "ipAddress": ipAddress},
	}
}

func runImpossibleTravelGoogleOnce(t *testing.T, conn clickhouse.Conn, producer *kgo.Client) {
	t.Helper()
	r := parseRule(t, "impossible-travel-google")
	sched, err := New([]*sigmac.Rule{r}, conn, producer, Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if len(sched.rules) != 1 {
		t.Fatalf("expected exactly one scheduled rule, got %d", len(sched.rules))
	}
	sched.runOnce(context.Background(), sched.rules[0])
}

func TestImpossibleTravelGoogle_FiresForTwoCountrySignInPair(t *testing.T) {
	tenantID := randomUUID(t)
	actorEmail := "user-" + randomUUID(t) + "@example.com"
	writer := newTestWriter(t)
	conn := newTestConn(t)
	t.Cleanup(func() { deleteTenantEvents(t, conn, tenantID) })

	now := time.Now().UTC()
	rows := []sentinelevents.EventRow{
		googleSignInEvent(tenantID, "evt-"+randomUUID(t), actorEmail, "203.0.113.10", now.Add(-5*time.Minute)),
		googleSignInEvent(tenantID, "evt-"+randomUUID(t), actorEmail, "198.51.100.20", now.Add(-1*time.Minute)),
	}
	if err := writer.Write(context.Background(), rows); err != nil {
		t.Fatalf("seeding events: %v", err)
	}

	producer, err := kgo.NewClient(kgo.SeedBrokers(brokers))
	if err != nil {
		t.Fatalf("creating producer: %v", err)
	}
	defer producer.Close()

	runImpossibleTravelGoogleOnce(t, conn, producer)

	got := collectSignals(t, tenantID, 1, 15*time.Second)
	if len(got) != 1 {
		t.Fatalf("got %d signals for tenant %s, want exactly 1: %+v", len(got), tenantID, got)
	}
	sig := got[0]
	if sig.RuleID != "8f1a2b3c-0002-4a00-9000-000000000009" {
		t.Errorf("RuleID = %q, want the impossible-travel-google rule id", sig.RuleID)
	}
	if sig.EntityID != actorEmail {
		t.Errorf("EntityID = %q, want %q", sig.EntityID, actorEmail)
	}
	if len(sig.EventIDs) != 2 {
		t.Errorf("EventIDs = %v, want both contributing sign-ins", sig.EventIDs)
	}
}

// Mirrors TestImpossibleTravel_DoesNotFireForSameIPTravel — same-IP travel
// (e.g. a corporate VPN exit node) must not fire for Google either.
func TestImpossibleTravelGoogle_DoesNotFireForSameIPTravel(t *testing.T) {
	tenantID := randomUUID(t)
	actorEmail := "user-" + randomUUID(t) + "@example.com"
	writer := newTestWriter(t)
	conn := newTestConn(t)
	t.Cleanup(func() { deleteTenantEvents(t, conn, tenantID) })

	now := time.Now().UTC()
	rows := []sentinelevents.EventRow{
		googleSignInEvent(tenantID, "evt-"+randomUUID(t), actorEmail, "203.0.113.10", now.Add(-5*time.Minute)),
		googleSignInEvent(tenantID, "evt-"+randomUUID(t), actorEmail, "203.0.113.10", now.Add(-1*time.Minute)),
	}
	if err := writer.Write(context.Background(), rows); err != nil {
		t.Fatalf("seeding events: %v", err)
	}

	producer, err := kgo.NewClient(kgo.SeedBrokers(brokers))
	if err != nil {
		t.Fatalf("creating producer: %v", err)
	}
	defer producer.Close()

	runImpossibleTravelGoogleOnce(t, conn, producer)

	got := collectSignals(t, tenantID, 1, 5*time.Second)
	if len(got) != 0 {
		t.Fatalf("got %d signals for same-IP travel, want 0: %+v", len(got), got)
	}
}
