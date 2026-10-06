//go:build integration

package worker

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
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/detectgen"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/dispatch"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/hotfix"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/suppression"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

const brokers = "localhost:19092"
const corpusDir = "../../../../detections/rules"

func randomID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("generating random id: %v", err)
	}
	return fmt.Sprintf("%x", b)
}

// TestMain truncates events.normalized and signals before this package's
// integration tests run — the same reasoning
// go/sentinelevents/consumer_integration_test.go's own TestMain gives:
// every fresh consumer group here reads AtStart(), which only stays fast
// and correct when earlier runs (including other packages' own load
// tests) have not left millions of irrelevant records on these topics.
func TestMain(m *testing.M) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if client, err := kgo.NewClient(kgo.SeedBrokers(brokers)); err == nil {
		admin := kadm.NewClient(client)
		for _, topic := range []string{sentinelstream.EventsNormalized, sentinelstream.Signals, sentinelstream.CriticalAlerts} {
			if end, err := admin.ListEndOffsets(ctx, topic); err == nil {
				_, _ = admin.DeleteRecords(ctx, end.Offsets())
			}
		}
		client.Close()
	}
	os.Exit(m.Run())
}

func buildRealTree(t *testing.T) *dispatch.Tree {
	t.Helper()
	rules, errs := sigmac.ParseCorpus(corpusDir)
	if len(errs) != 0 {
		t.Fatalf("parsing corpus: %v", errs)
	}
	tree, err := dispatch.Build(rules, detectgen.Rules, dispatch.Options{})
	if err != nil {
		t.Fatalf("dispatch.Build: %v", err)
	}
	return tree
}

func newWorker(t *testing.T, group string) (*Worker, *kgo.Client, *kgo.Client) {
	t.Helper()
	consumer, err := kgo.NewClient(
		kgo.SeedBrokers(brokers),
		kgo.ConsumeTopics(sentinelstream.EventsNormalized),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		t.Fatalf("creating consumer client: %v", err)
	}
	producer, err := kgo.NewClient(kgo.SeedBrokers(brokers))
	if err != nil {
		t.Fatalf("creating producer client: %v", err)
	}
	w := New(buildRealTree(t), consumer, producer, Options{Group: group})
	return w, consumer, producer
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

// collectSignals reads every signal published for tenantID from a fresh
// consumer group over `signals`, AtStart, until n have arrived or the
// deadline passes.
func collectSignals(t *testing.T, tenantID string, n int, timeout time.Duration) []sentinelsignal.Signal {
	t.Helper()
	return collectSignalsFromTopic(t, sentinelstream.Signals, tenantID, n, timeout)
}

// collectCriticalAlerts is collectSignals' own counterpart for the
// direct bypass topic (P2-08) — a separate function, not a shared one
// with a topic parameter the normal (non-test) code never needs,
// because the two topics' own test setup already differs enough
// (alerts.critical) to be worth naming explicitly at call sites.
func collectCriticalAlerts(t *testing.T, tenantID string, n int, timeout time.Duration) []sentinelsignal.Signal {
	t.Helper()
	return collectSignalsFromTopic(t, sentinelstream.CriticalAlerts, tenantID, n, timeout)
}

func collectSignalsFromTopic(t *testing.T, topic, tenantID string, n int, timeout time.Duration) []sentinelsignal.Signal {
	t.Helper()
	group := "test-collect-" + randomID(t)
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

// T1: a known malicious event sequence produces exactly the expected
// signal set. "New-InboxRule" is new-inbox-forwarding-rule.yml's own
// positive fixture (detections/fixtures/new-inbox-forwarding-rule.positive.json)
// reproduced as a real wire event, chosen specifically because, among the
// 8-rule corpus, it is the only in-stream rule whose selection matches
// this Operation value — proven by P2-03's own exhaustive-evaluation fuzz
// test, not asserted on faith here.
func TestWorker_KnownMaliciousSequenceProducesExpectedSignals(t *testing.T) {
	tenantID := randomID(t)
	eventID := "evt-" + tenantID
	group := "test-detect-t1-" + tenantID

	w, consumer, producer := newWorker(t, group)
	defer consumer.Close()
	defer producer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go func() { _ = w.Run(ctx) }()

	produceWireEvent(t, wireEvent{
		TenantID: tenantID,
		EventID:  eventID,
		ClassUID: 3005, ActivityID: 1, SeverityID: 1,
		Metadata: map[string]string{"product": "m365", "operation": "New-InboxRule"},
	})

	got := collectSignals(t, tenantID, 1, 15*time.Second)
	if len(got) != 1 {
		t.Fatalf("got %d signals for tenant %s, want exactly 1: %+v", len(got), tenantID, got)
	}
	sig := got[0]
	if sig.RuleID != "8f1a2b3c-0001-4a00-9000-000000000001" {
		t.Errorf("RuleID = %q, want the new-inbox-forwarding-rule id", sig.RuleID)
	}
	if len(sig.EventIDs) != 1 || sig.EventIDs[0] != eventID {
		t.Errorf("EventIDs = %v, want [%q]", sig.EventIDs, eventID)
	}
	if sig.Severity != "medium" {
		t.Errorf("Severity = %q, want medium", sig.Severity)
	}
	if len(sig.MitreIDs) != 1 || sig.MitreIDs[0] != "attack.t1114.003" {
		t.Errorf("MitreIDs = %v, want [attack.t1114.003]", sig.MitreIDs)
	}
}

// T2: a worker crash mid-batch replays without losing signals. Worker A
// consumes the record but is stopped (simulating a crash) before its
// poll's own CommitUncommittedOffsets ever runs — achieved the same way
// go/sentinelevents's own T1 proves it, by giving it a context that
// expires before a poll cycle completes. Worker B, same group, fresh
// client, must still produce the signal: the record was never committed,
// so AtStart's own committed-offset resume point is still before it.
func TestWorker_CrashMidBatchReplaysWithoutLosingSignals(t *testing.T) {
	tenantID := randomID(t)
	eventID := "evt-" + tenantID
	group := "test-detect-t2-" + tenantID

	produceWireEvent(t, wireEvent{
		TenantID: tenantID,
		EventID:  eventID,
		ClassUID: 3005, ActivityID: 1, SeverityID: 1,
		Metadata: map[string]string{"product": "m365", "operation": "New-InboxRule"},
	})

	consumerA, err := kgo.NewClient(
		kgo.SeedBrokers(brokers),
		kgo.ConsumeTopics(sentinelstream.EventsNormalized),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		t.Fatalf("creating consumer A: %v", err)
	}
	producerA, err := kgo.NewClient(kgo.SeedBrokers(brokers))
	if err != nil {
		t.Fatalf("creating producer A: %v", err)
	}
	workerA := New(buildRealTree(t), consumerA, producerA, Options{Group: group})

	// A context that expires mid-poll, before Run's own loop ever reaches
	// CommitUncommittedOffsets — the crash this test simulates.
	ctxA, cancelA := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	_ = workerA.Run(ctxA)
	cancelA()
	consumerA.Close()
	producerA.Close()

	// Worker B: same group, fresh clients — must pick up from the last
	// COMMITTED offset, which worker A never advanced.
	w, consumerB, producerB := newWorker(t, group)
	defer consumerB.Close()
	defer producerB.Close()

	ctxB, cancelB := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelB()
	go func() { _ = w.Run(ctxB) }()

	got := collectSignals(t, tenantID, 1, 15*time.Second)
	if len(got) < 1 {
		t.Fatalf("got %d signals for tenant %s after restart, want at least 1 (no loss)", len(got), tenantID)
	}
	if len(got[0].EventIDs) != 1 || got[0].EventIDs[0] != eventID {
		t.Errorf("EventIDs = %v, want [%q]", got[0].EventIDs, eventID)
	}
}

// P2-08/TG4, T1+T2+T3 combined: a critical signal is delivered on the
// direct bypass path with no other service involved at all. "Kill the
// analyst/correlation service and the LLM provider" (the ticket's own
// chaos-test framing) isn't literally exercisable here — neither
// service exists yet (correlation is P3, the AI analyst is P4) — but
// this test proves the stronger, more direct property that actually
// matters: delivery to alerts.critical succeeds, within a tight SLA,
// with ZERO consumer ever joined to `signals` and nothing resembling an
// LLM client anywhere in this process. A dependency on any of those
// would have to be a real call this test could observe hanging or
// failing; there is structurally nowhere for one to hide.
func TestWorker_CriticalSignalDeliveredWithNoOtherServiceAlive(t *testing.T) {
	tenantID := randomID(t)
	eventID := "evt-" + tenantID
	group := "test-detect-t208-" + tenantID

	w, consumer, producer := newWorker(t, group)
	defer consumer.Close()
	defer producer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go func() { _ = w.Run(ctx) }()

	start := time.Now()
	produceWireEvent(t, wireEvent{
		TenantID: tenantID,
		EventID:  eventID,
		ClassUID: 3005, ActivityID: 1, SeverityID: 1,
		// mfa-requirement-removed.yml's own trigger — promoted to
		// level: critical by this ticket.
		Metadata: map[string]string{"product": "m365", "operation": "Disable Strong Authentication."},
	})

	const sla = 10 * time.Second
	got := collectCriticalAlerts(t, tenantID, 1, sla)
	elapsed := time.Since(start)

	if len(got) != 1 {
		t.Fatalf("got %d critical alerts for tenant %s within the %v SLA, want exactly 1: %+v", len(got), tenantID, sla, got)
	}
	if elapsed > sla {
		t.Fatalf("critical alert took %v, want within the %v SLA", elapsed, sla)
	}
	alert := got[0]
	if alert.RuleID != "8f1a2b3c-0001-4a00-9000-000000000016" {
		t.Errorf("RuleID = %q, want the mfa-requirement-removed rule id", alert.RuleID)
	}
	if alert.Severity != "critical" {
		t.Errorf("Severity = %q, want critical", alert.Severity)
	}
	if alert.OwnerDescription == "" {
		t.Error("OwnerDescription is empty — AC3: a bypass alert must be labelled with the rule's own plain-English description, not an AI narrative")
	}
	if alert.DedupeKey == "" {
		t.Error("DedupeKey is empty")
	}

	// AC4's own data contract: the SAME signal, on the normal `signals`
	// path (which this test's worker also published to, unconditionally
	// — see handleRecord), must carry the IDENTICAL DedupeKey, so a
	// future notifier can actually collapse the two into one
	// notification.
	normal := collectSignals(t, tenantID, 1, 5*time.Second)
	if len(normal) != 1 {
		t.Fatalf("got %d signals on the normal path, want exactly 1: %+v", len(normal), normal)
	}
	if normal[0].DedupeKey != alert.DedupeKey {
		t.Errorf("DedupeKey mismatch between the normal signal (%q) and the bypass alert (%q) for the same detection", normal[0].DedupeKey, alert.DedupeKey)
	}
}

// ── P2-10/TG3 fixtures ──────────────────────────────────────────────────────
//
// Suppressions live in real Postgres (0006_suppressions.sql), with real FK
// constraints back to tenants(id)/users(id) — unlike every other fixture in
// this file, which only needs a tenant id shaped like a plausible string on
// the Kafka wire, these tests need a REAL tenants row, whose id (returned
// by createTenantAndUser below, via Postgres's own gen_random_uuid()) is
// used as the test's tenantID throughout — both on the wire and as the
// suppression's tenant_id — since sentineldb.WithTenantContext refuses any
// tenant id that isn't actually UUID-shaped, unlike randomID's bare hex.

func newSuppressionPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := sentineldb.NewPool(context.Background())
	if err != nil {
		t.Fatalf("connecting to postgres: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// createTenantAndUser inserts real fixture rows directly over the pool's
// default (superuser) connection — fixture setup, not the code under test,
// which is PostgresChecker.IsSuppressed's own tenant-scoped read below.
func createTenantAndUser(t *testing.T, pool *pgxpool.Pool) (tenantID, userID string) {
	t.Helper()
	ctx := context.Background()
	if err := pool.QueryRow(ctx,
		`INSERT INTO tenants (name, plan) VALUES ($1, 'trial') RETURNING id`,
		"P2-10 suppression probe "+randomID(t),
	).Scan(&tenantID); err != nil {
		t.Fatalf("creating tenant fixture: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`,
		"p2-10-probe-"+randomID(t)+"@example.invalid", "P2-10 probe user",
	).Scan(&userID); err != nil {
		t.Fatalf("creating user fixture: %v", err)
	}
	t.Cleanup(func() {
		// Cascades through suppressions (ON DELETE CASCADE) too.
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})
	return tenantID, userID
}

// insertSuppression writes a real suppressions row, expiring `in` from now
// — always a positive duration, never a pre-expired timestamp: the table's
// own CHECK (expires_at > created_at) makes "already expired at creation"
// unrepresentable by construction, so T2 below proves expiry by waiting for
// real time to pass a short-lived suppression, not by backdating one.
// entityID == "" inserts a NULL (tenant+rule-wide) suppression.
func insertSuppression(t *testing.T, pool *pgxpool.Pool, tenantID, ruleID, entityID, createdBy string, in time.Duration) {
	t.Helper()
	var entity any
	if entityID != "" {
		entity = entityID
	}
	_, err := pool.Exec(context.Background(),
		`INSERT INTO suppressions (tenant_id, rule_id, entity_id, reason, created_by, expires_at)
		 VALUES ($1, $2, $3, 'P2-10 integration test probe', $4, $5)`,
		tenantID, ruleID, entity, createdBy, time.Now().Add(in),
	)
	if err != nil {
		t.Fatalf("inserting suppression fixture: %v", err)
	}
}

// mfaRequirementRemovedRuleID is mfa-requirement-removed.yml's own id —
// P2-08's own critical rule, reused here because it is already the exact
// trigger TestWorker_CriticalSignalDeliveredWithNoOtherServiceAlive uses.
const mfaRequirementRemovedRuleID = "8f1a2b3c-0001-4a00-9000-000000000016"

func mfaRemovedEvent(tenantID, eventID string) wireEvent {
	return wireEvent{
		TenantID: tenantID,
		EventID:  eventID,
		ClassUID: 3005, ActivityID: 1, SeverityID: 1,
		Metadata: map[string]string{"product": "m365", "operation": "Disable Strong Authentication."},
	}
}

// T1 (AC3): "Suppressed signals are still stored and counted, just not
// escalated." A wildcard (entity-less) suppression on the critical rule
// used above must still let the normal `signals` publish through —
// disclosing Suppressed/SuppressionID on the stored record — while the
// alerts.critical bypass does not fire at all.
func TestWorker_SuppressedCriticalSignalStillStoredButNotEscalated(t *testing.T) {
	pool := newSuppressionPool(t)
	tenantID, userID := createTenantAndUser(t, pool)
	eventID := "evt-" + tenantID
	group := "test-detect-p210-t1-" + tenantID

	insertSuppression(t, pool, tenantID, mfaRequirementRemovedRuleID, "", userID, 5*time.Minute)

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

	w := New(buildRealTree(t), consumer, producer, Options{
		Group:              group,
		SuppressionChecker: suppression.NewPostgresChecker(pool),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go func() { _ = w.Run(ctx) }()

	produceWireEvent(t, mfaRemovedEvent(tenantID, eventID))

	normal := collectSignals(t, tenantID, 1, 15*time.Second)
	if len(normal) != 1 {
		t.Fatalf("got %d signals on the normal path, want exactly 1 (AC3: still stored)", len(normal))
	}
	if !normal[0].Suppressed {
		t.Error("Suppressed = false, want true — the stored signal must disclose its own suppression")
	}
	if normal[0].SuppressionID == "" {
		t.Error("SuppressionID is empty, want the responsible suppression's id")
	}

	alerts := collectCriticalAlerts(t, tenantID, 1, 3*time.Second)
	if len(alerts) != 0 {
		t.Fatalf("got %d critical alerts, want 0 — a suppressed critical signal must not escalate", len(alerts))
	}

	// AC5: "what they have suppressed" — PostgresChecker.IsSuppressed
	// increments this atomically on every match.
	var count int
	if err := pool.QueryRow(context.Background(),
		`SELECT suppressed_count FROM suppressions WHERE id = $1`, normal[0].SuppressionID,
	).Scan(&count); err != nil {
		t.Fatalf("reading suppressed_count: %v", err)
	}
	if count < 1 {
		t.Errorf("suppressed_count = %d, want at least 1", count)
	}
}

// T2 (AC4): "Suppressions expire by default." A short-lived suppression
// stops suppressing once real time passes its expires_at — proven by
// producing the same trigger twice against one still-running worker, once
// while the suppression is live and once after it has expired.
func TestWorker_SuppressionStopsApplyingAfterItExpires(t *testing.T) {
	pool := newSuppressionPool(t)
	tenantID, userID := createTenantAndUser(t, pool)
	group := "test-detect-p210-t2-" + tenantID

	const livenessWindow = 3 * time.Second
	insertSuppression(t, pool, tenantID, mfaRequirementRemovedRuleID, "", userID, livenessWindow)

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

	w := New(buildRealTree(t), consumer, producer, Options{
		Group:              group,
		SuppressionChecker: suppression.NewPostgresChecker(pool),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	go func() { _ = w.Run(ctx) }()

	// While live: no critical alert.
	produceWireEvent(t, mfaRemovedEvent(tenantID, "evt-live-"+tenantID))
	if alerts := collectCriticalAlerts(t, tenantID, 1, 2*time.Second); len(alerts) != 0 {
		t.Fatalf("got %d critical alerts while the suppression is still live, want 0", len(alerts))
	}

	// Wait past expires_at, then trigger again: must escalate normally.
	time.Sleep(livenessWindow + 1*time.Second)
	produceWireEvent(t, mfaRemovedEvent(tenantID, "evt-expired-"+tenantID))
	alerts := collectCriticalAlerts(t, tenantID, 1, 15*time.Second)
	if len(alerts) != 1 {
		t.Fatalf("got %d critical alerts after expiry, want exactly 1 — an expired suppression must stop applying", len(alerts))
	}
}

// T3: cross-tenant isolation. A suppression created for tenant A must never
// suppress the identical rule for tenant B — the same RLS guarantee
// packages/db/src/__tests__/tenant-isolation.integration.test.ts proves on
// the TypeScript side, exercised here through PostgresChecker instead.
func TestWorker_SuppressionDoesNotCrossTenants(t *testing.T) {
	pool := newSuppressionPool(t)
	tenantA, userA := createTenantAndUser(t, pool)
	tenantB, _ := createTenantAndUser(t, pool)
	group := "test-detect-p210-t3-" + tenantA

	insertSuppression(t, pool, tenantA, mfaRequirementRemovedRuleID, "", userA, 5*time.Minute)

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

	w := New(buildRealTree(t), consumer, producer, Options{
		Group:              group,
		SuppressionChecker: suppression.NewPostgresChecker(pool),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go func() { _ = w.Run(ctx) }()

	produceWireEvent(t, mfaRemovedEvent(tenantA, "evt-a-"+tenantA))
	produceWireEvent(t, mfaRemovedEvent(tenantB, "evt-b-"+tenantB))

	if alerts := collectCriticalAlerts(t, tenantA, 1, 3*time.Second); len(alerts) != 0 {
		t.Fatalf("got %d critical alerts for suppressed tenant A, want 0", len(alerts))
	}
	alertsB := collectCriticalAlerts(t, tenantB, 1, 15*time.Second)
	if len(alertsB) != 1 {
		t.Fatalf("got %d critical alerts for tenant B, want exactly 1 — tenant A's suppression must not leak", len(alertsB))
	}
}

// ── P2-12/ADR-0004 ───────────────────────────────────────────────────────
//
// The end-to-end proof: a hotfix rule inserted directly into real
// Postgres (the same way apps/api's own route would, minus the HTTP
// layer) is picked up by a real hotfix.Loader backed by a real
// hotfix.PostgresSource, and a real event matching it produces a real
// Signal through the real worker — not a unit test of any one layer in
// isolation.

func insertWorkerHotfixRule(t *testing.T, pool *pgxpool.Pool, ruleID, createdBy string) string {
	t.Helper()
	ruleYAML := "id: " + ruleID + `
title: Worker hotfix end-to-end probe
owner_description: A probe rule for the worker package's own P2-12 integration test.
tags:
  - attack.t1078
logsource:
  product: m365
detection:
  selection:
    Operation: 'EmergencyHotfixProbeOperation'
  condition: selection
level: high
`
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO hotfix_rules (rule_id, rule_title, rule_yaml, reason, created_by)
		 VALUES ($1, $1, $2, 'P2-12 worker integration test probe', $3)
		 RETURNING id`,
		ruleID, ruleYAML, createdBy,
	).Scan(&id)
	if err != nil {
		t.Fatalf("inserting hotfix rule fixture: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM hotfix_rules WHERE id = $1`, id)
	})
	return id
}

func TestWorker_HotfixRuleEvaluatesAgainstRealEvent(t *testing.T) {
	pool := newSuppressionPool(t) // reuses P2-10's own real-Postgres pool helper; no suppression used here
	tenantID, userID := createTenantAndUser(t, pool)
	hotfixRuleID := "p2-12-worker-e2e-" + tenantID
	insertWorkerHotfixRule(t, pool, hotfixRuleID, userID)

	loader := hotfix.NewLoader(hotfix.NewPostgresSource(pool), nil)
	loaderCtx, cancelLoader := context.WithCancel(context.Background())
	defer cancelLoader()
	go loader.Run(loaderCtx, 50*time.Millisecond)

	// Wait for the loader's own background refresh to actually pick up
	// the fixture before starting the worker — otherwise the first
	// event could race a loader that hasn't loaded anything yet.
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) && len(loader.Active()) == 0 {
		time.Sleep(50 * time.Millisecond)
	}
	if len(loader.Active()) == 0 {
		t.Fatalf("hotfix loader never loaded the fixture rule within the deadline")
	}

	group := "test-detect-p212-" + tenantID
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

	w := New(buildRealTree(t), consumer, producer, Options{Group: group, HotfixRules: loader})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go func() { _ = w.Run(ctx) }()

	eventID := "evt-" + tenantID
	produceWireEvent(t, wireEvent{
		TenantID: tenantID,
		EventID:  eventID,
		ClassUID: 3005, ActivityID: 1, SeverityID: 1,
		Metadata: map[string]string{"product": "m365", "operation": "EmergencyHotfixProbeOperation"},
	})

	got := collectSignals(t, tenantID, 1, 15*time.Second)
	if len(got) != 1 {
		t.Fatalf("got %d signals for tenant %s, want exactly 1: %+v", len(got), tenantID, got)
	}
	sig := got[0]
	if sig.RuleID != hotfixRuleID {
		t.Errorf("RuleID = %q, want %q", sig.RuleID, hotfixRuleID)
	}
	if sig.Engine != engineHotfix {
		t.Errorf("Engine = %q, want %q", sig.Engine, engineHotfix)
	}
	if len(sig.EventIDs) != 1 || sig.EventIDs[0] != eventID {
		t.Errorf("EventIDs = %v, want [%q]", sig.EventIDs, eventID)
	}
}
