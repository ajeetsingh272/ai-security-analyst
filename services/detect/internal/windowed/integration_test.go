//go:build integration

package windowed

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelevents"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelsignal"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/suppression"
	"github.com/jackc/pgx/v5/pgxpool"
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
	return collectFromTopic(t, sentinelstream.Signals, tenantID, n, timeout)
}

// collectCriticalAlerts is collectSignals' own counterpart for the direct
// bypass topic (P2-08/P2-10) — see services/detect/internal/worker's
// identical split for why this stays a separate, named function rather
// than a topic parameter ordinary (non-test) code would never need.
func collectCriticalAlerts(t *testing.T, tenantID string, n int, timeout time.Duration) []sentinelsignal.Signal {
	t.Helper()
	return collectFromTopic(t, sentinelstream.CriticalAlerts, tenantID, n, timeout)
}

func collectFromTopic(t *testing.T, topic, tenantID string, n int, timeout time.Duration) []sentinelsignal.Signal {
	t.Helper()
	group := "test-windowed-collect-" + randomUUID(t)
	client, err := kgo.NewClient(
		kgo.SeedBrokers(brokers),
		kgo.ConsumeTopics(topic),
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

// ── P2-10/TG3 ────────────────────────────────────────────────────────────
//
// No rule in today's real windowed corpus is level: critical (all three
// are high — see scanSignals_test.go's own TestScanSignals_
// CriticalLevelCarriesThroughToSeverity for the same situation), so this
// reuses that file's synthetic-critical-rule approach, paired with
// scheduler_test.go's fakeConn/fakeRows so no real ClickHouse data needs
// to exist for a rule that isn't real — Postgres (suppression) and Kafka
// (producer, signals/alerts.critical) stay genuinely real underneath.

func newWindowedSuppressionPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := sentineldb.NewPool(context.Background())
	if err != nil {
		t.Fatalf("connecting to postgres: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func createWindowedTenantAndUser(t *testing.T, pool *pgxpool.Pool) (tenantID, userID string) {
	t.Helper()
	ctx := context.Background()
	if err := pool.QueryRow(ctx,
		`INSERT INTO tenants (name, plan) VALUES ($1, 'trial') RETURNING id`,
		"P2-10 windowed suppression probe "+randomUUID(t),
	).Scan(&tenantID); err != nil {
		t.Fatalf("creating tenant fixture: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`,
		"p2-10-windowed-probe-"+randomUUID(t)+"@example.invalid", "P2-10 windowed probe user",
	).Scan(&userID); err != nil {
		t.Fatalf("creating user fixture: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})
	return tenantID, userID
}

func insertWindowedSuppression(t *testing.T, pool *pgxpool.Pool, tenantID, ruleID, entityID, createdBy string, in time.Duration) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO suppressions (tenant_id, rule_id, entity_id, reason, created_by, expires_at)
		 VALUES ($1, $2, $3, 'P2-10 windowed integration test probe', $4, $5)`,
		tenantID, ruleID, entityID, createdBy, time.Now().Add(in),
	)
	if err != nil {
		t.Fatalf("inserting suppression fixture: %v", err)
	}
}

func syntheticCriticalWindowedRule(id string) *sigmac.Rule {
	return &sigmac.Rule{
		ID: id, Slug: id, Title: "Synthetic critical windowed rule", Level: "critical",
		MitreIDs:         []string{"attack.t1078"},
		OwnerDescription: "A synthetic critical windowed rule for P2-10 testing.",
		Selections: map[string]sigmac.Selection{
			"selection": {Name: "selection", Fields: []sigmac.FieldMatch{
				{SigmaField: "Operation", OCSFPath: "metadata.operation", Modifier: sigmac.ModEquals, Values: []string{"X"}},
			}},
		},
		Condition: sigmac.SelectionRef{Name: "selection"},
		Engine:    sigmac.EngineWindowed,
		Aggregation: &sigmac.Aggregation{
			GroupBy: []string{"UserId"}, Op: "count", Comparator: ">", Threshold: 1, Window: 10 * time.Minute,
		},
	}
}

// T1 (AC3) + entity-scoping: unlike the in-stream worker, a windowed
// signal has a real EntityID — this proves a suppression scoped to ONE
// entity ("alice") silences only that entity's own escalation, while a
// different entity ("bob") matched by the SAME rule in the SAME tick
// still escalates normally, both signals still landing on the normal
// `signals` topic either way (AC3's "still stored and counted").
func TestRunOnce_SuppressedWindowedCriticalSignalStillStoredButNotEscalated(t *testing.T) {
	pool := newWindowedSuppressionPool(t)
	tenantID, userID := createWindowedTenantAndUser(t, pool)
	ruleID := "synthetic-critical-windowed-" + randomUUID(t)

	insertWindowedSuppression(t, pool, tenantID, ruleID, "alice", userID, 5*time.Minute)

	r := syntheticCriticalWindowedRule(ruleID)
	q, err := BuildQuery(r)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}
	conn := &fakeConn{queryFn: func(context.Context, string, ...any) (driver.Rows, error) {
		return &fakeRows{rows: []fakeRow{
			{tenantID: tenantID, groupKey: "alice", aggValue: 5, eventIDs: []string{"evt-alice"}},
			{tenantID: tenantID, groupKey: "bob", aggValue: 5, eventIDs: []string{"evt-bob"}},
		}}, nil
	}}

	producer, err := kgo.NewClient(kgo.SeedBrokers(brokers))
	if err != nil {
		t.Fatalf("creating producer: %v", err)
	}
	defer producer.Close()

	s := &Scheduler{conn: conn, producer: producer, log: slog.New(slog.NewTextHandler(io.Discard, nil)), suppressor: suppression.NewPostgresChecker(pool)}
	s.runOnce(context.Background(), scheduledRule{query: q, interval: time.Second})

	normal := collectSignals(t, tenantID, 2, 15*time.Second)
	if len(normal) != 2 {
		t.Fatalf("got %d signals, want exactly 2 (AC3: both still stored): %+v", len(normal), normal)
	}
	byEntity := map[string]sentinelsignal.Signal{}
	for _, sig := range normal {
		byEntity[sig.EntityID] = sig
	}
	alice, ok := byEntity["alice"]
	if !ok {
		t.Fatalf("no signal for alice in %+v", normal)
	}
	if !alice.Suppressed || alice.SuppressionID == "" {
		t.Errorf("alice's signal = %+v, want Suppressed=true with a SuppressionID", alice)
	}
	bob, ok := byEntity["bob"]
	if !ok {
		t.Fatalf("no signal for bob in %+v", normal)
	}
	if bob.Suppressed {
		t.Errorf("bob's signal = %+v, want Suppressed=false — the suppression is scoped to alice only", bob)
	}

	alerts := collectCriticalAlerts(t, tenantID, 1, 15*time.Second)
	if len(alerts) != 1 || alerts[0].EntityID != "bob" {
		t.Fatalf("critical alerts = %+v, want exactly 1 for bob — alice's is suppressed, bob's must still escalate", alerts)
	}
}
