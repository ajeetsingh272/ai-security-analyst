//go:build integration

package customerrules

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelsignal"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

const brokers = "localhost:19092"

func randomID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("generating random id: %v", err)
	}
	return fmt.Sprintf("%x", b)
}

// TestMain truncates events.normalized and signals before this
// package's integration tests run — the same reasoning
// services/detect/internal/worker's own TestMain gives: every fresh
// consumer group here reads AtStart(), which only stays fast and
// correct when earlier runs have not left irrelevant records behind.
func TestMain(m *testing.M) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if client, err := kgo.NewClient(kgo.SeedBrokers(brokers)); err == nil {
		admin := kadm.NewClient(client)
		for _, topic := range []string{sentinelstream.EventsNormalized, sentinelstream.Signals} {
			if end, err := admin.ListEndOffsets(ctx, topic); err == nil {
				_, _ = admin.DeleteRecords(ctx, end.Offsets())
			}
		}
		client.Close()
	}
	os.Exit(m.Run())
}

func newPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := sentineldb.NewPool(context.Background())
	if err != nil {
		t.Fatalf("connecting to postgres: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func createTenantAndUser(t *testing.T, pool *pgxpool.Pool) (tenantID, userID string) {
	t.Helper()
	ctx := context.Background()
	if err := pool.QueryRow(ctx,
		`INSERT INTO tenants (name, plan) VALUES ($1, 'trial') RETURNING id`,
		"P7-10 customer-rule probe "+randomID(t),
	).Scan(&tenantID); err != nil {
		t.Fatalf("creating tenant fixture: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`,
		"p7-10-probe-"+randomID(t)+"@example.invalid", "P7-10 probe user",
	).Scan(&userID); err != nil {
		t.Fatalf("creating user fixture: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})
	return tenantID, userID
}

// insertCustomerRule writes a real pending customer_rules row directly,
// as apps/api's own POST /customer-rules route would — fixture setup,
// not the code under test (the Activator/Loader/Worker are).
func insertCustomerRule(t *testing.T, pool *pgxpool.Pool, tenantID, userID, ruleYAML string, positive, negative map[string]string) string {
	t.Helper()
	posJSON, err := json.Marshal(positive)
	if err != nil {
		t.Fatalf("marshalling positive fixture: %v", err)
	}
	negJSON, err := json.Marshal(negative)
	if err != nil {
		t.Fatalf("marshalling negative fixture: %v", err)
	}
	var rowID string
	err = pool.QueryRow(context.Background(),
		`INSERT INTO customer_rules (tenant_id, rule_id, rule_title, rule_yaml, positive_fixture, negative_fixture, created_by)
		 VALUES ($1, 'probe', 'probe rule', $2, $3, $4, $5) RETURNING id`,
		tenantID, ruleYAML, posJSON, negJSON, userID,
	).Scan(&rowID)
	if err != nil {
		t.Fatalf("inserting customer_rules fixture: %v", err)
	}
	return rowID
}

func customerRuleStatus(t *testing.T, pool *pgxpool.Pool, rowID string) (status string, reason *string) {
	t.Helper()
	if err := pool.QueryRow(context.Background(), `SELECT status, rejection_reason FROM customer_rules WHERE id = $1`, rowID).Scan(&status, &reason); err != nil {
		t.Fatalf("reading customer_rules status: %v", err)
	}
	return status, reason
}

// T4: "A rule failing its own fixtures cannot be activated" — against
// real Postgres, the real Activator, no fakes.
func TestActivator_ActivatesAGoodRuleAgainstRealPostgres(t *testing.T) {
	pool := newPool(t)
	tenantID, userID := createTenantAndUser(t, pool)

	rowID := insertCustomerRule(t, pool, tenantID, userID, validRuleYAML, matchingFixture, nonMatchingFixture)

	store := NewPostgresActivatorStore(pool)
	NewActivator(store, nil).runOnce(context.Background())

	status, _ := customerRuleStatus(t, pool, rowID)
	if status != "active" {
		t.Fatalf("status = %q, want active", status)
	}
}

func TestActivator_RejectsARuleThatFailsItsOwnFixturesAgainstRealPostgres(t *testing.T) {
	pool := newPool(t)
	tenantID, userID := createTenantAndUser(t, pool)

	rowID := insertCustomerRule(t, pool, tenantID, userID, validRuleYAML, nonMatchingFixture, nonMatchingFixture)

	store := NewPostgresActivatorStore(pool)
	NewActivator(store, nil).runOnce(context.Background())

	status, reason := customerRuleStatus(t, pool, rowID)
	if status != "rejected" {
		t.Fatalf("status = %q, want rejected", status)
	}
	if reason == nil || *reason == "" {
		t.Fatal("expected a non-empty rejection_reason")
	}
}

// T2/AC5: the central claim, proven end to end against real Postgres
// AND real Redpanda — two tenants, each with their own ACTIVE rule
// that matches the SAME shape of event, one published event for
// tenant A only, and tenant B never produces a signal despite its own
// rule being perfectly capable of matching that exact event shape.
// This is what makes the test meaningful: isolation is proven by
// construction (the event never reaches tenant B's rule at all), not
// by the rules happening to differ.
func TestWorker_NeverEvaluatesAnotherTenantsRuleAgainstRealInfra(t *testing.T) {
	pool := newPool(t)
	tenantA, userA := createTenantAndUser(t, pool)
	tenantB, userB := createTenantAndUser(t, pool)

	insertCustomerRule(t, pool, tenantA, userA, validRuleYAML, matchingFixture, nonMatchingFixture)
	insertCustomerRule(t, pool, tenantB, userB, validRuleYAML, matchingFixture, nonMatchingFixture)

	store := NewPostgresActivatorStore(pool)
	NewActivator(store, nil).runOnce(context.Background())

	loader := NewLoader(NewPostgresSource(pool), nil)
	loader.refreshOnce(context.Background())
	if len(loader.Active(tenantA)) != 1 {
		t.Fatalf("setup: tenant A should have exactly 1 active rule, got %d", len(loader.Active(tenantA)))
	}
	if len(loader.Active(tenantB)) != 1 {
		t.Fatalf("setup: tenant B should have exactly 1 active rule, got %d", len(loader.Active(tenantB)))
	}

	group := "test-customerrules-" + randomID(t)
	consumer, err := kgo.NewClient(
		kgo.SeedBrokers(brokers),
		kgo.ConsumeTopics(sentinelstream.EventsNormalized),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		t.Fatalf("creating consumer: %v", err)
	}
	defer consumer.Close()
	producer, err := kgo.NewClient(kgo.SeedBrokers(brokers))
	if err != nil {
		t.Fatalf("creating producer: %v", err)
	}
	defer producer.Close()

	tracker := NewSuspensionTracker(store, nil)
	w := New(loader, tracker, consumer, producer, Options{Group: group})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = w.Run(ctx) }()

	eventID := "evt-" + randomID(t)
	produceWireEvent(t, wireEvent{
		TenantID: tenantA, EventID: eventID,
		Metadata: map[string]string{"operation": "Consent to application."},
		Unmapped: map[string]string{"ConsentType": "AdminConsent"},
	})

	signals := collectSignals(t, tenantA, 1, 15*time.Second)
	if len(signals) != 1 {
		t.Fatalf("got %d signals for tenant A, want 1", len(signals))
	}
	if signals[0].Engine != engineCustomerRule {
		t.Errorf("Engine = %q, want %q", signals[0].Engine, engineCustomerRule)
	}

	// The direct T2 assertion: NO signal for tenant B, even though
	// tenant B's own rule would have matched this exact event shape
	// had it ever been evaluated against it.
	noSignalsForB := collectSignals(t, tenantB, 1, 3*time.Second)
	if len(noSignalsForB) != 0 {
		t.Fatalf("tenant B produced %d signals from tenant A's event — cross-tenant leak", len(noSignalsForB))
	}
}

func produceWireEvent(t *testing.T, ev wireEvent) {
	t.Helper()
	client, err := kgo.NewClient(kgo.SeedBrokers(brokers))
	if err != nil {
		t.Fatalf("creating producer client: %v", err)
	}
	defer client.Close()
	payload, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshalling event: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res := client.ProduceSync(ctx, &kgo.Record{Topic: sentinelstream.EventsNormalized, Key: []byte(ev.TenantID), Value: payload})
	if err := res.FirstErr(); err != nil {
		t.Fatalf("producing event: %v", err)
	}
}

func collectSignals(t *testing.T, tenantID string, n int, timeout time.Duration) []sentinelsignal.Signal {
	t.Helper()
	group := "test-collect-" + randomID(t)
	client, err := kgo.NewClient(
		kgo.SeedBrokers(brokers),
		kgo.ConsumeTopics(sentinelstream.Signals),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
	)
	if err != nil {
		t.Fatalf("creating collector client: %v", err)
	}
	defer client.Close()

	var out []sentinelsignal.Signal
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) && len(out) < n {
		ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
		fetches := client.PollFetches(ctx)
		cancel()
		fetches.EachRecord(func(r *kgo.Record) {
			var sig sentinelsignal.Signal
			if err := json.Unmarshal(r.Value, &sig); err != nil {
				return
			}
			if sig.TenantID == tenantID {
				out = append(out, sig)
			}
		})
	}
	return out
}
