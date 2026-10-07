package windowed

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelsignal"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
	"github.com/google/uuid"
	"github.com/twmb/franz-go/pkg/kgo"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// Metrics are all optional (nil-safe) — the same pattern
// services/detect/internal/worker.Metrics and every other optional
// capability in this repo already uses.
type Metrics struct {
	SignalsEmitted        metric.Int64Counter
	QueryErrors           metric.Int64Counter
	QueryKilled           metric.Int64Counter
	CriticalAlertsEmitted metric.Int64Counter
}

// levelCritical is the one rule Level value that triggers the direct
// alert bypass (P2-08, SECURITY.md guarantee #4) — see
// services/detect/internal/worker's own identical constant; duplicated
// rather than shared, the same "no cross-engine coupling for one string"
// reasoning that constant's own doc comment already explains for
// engineInStream.
const levelCritical = "critical"

type Options struct {
	Log *slog.Logger
	Metrics
}

// levelInterval maps a rule's declared severity to its own schedule
// interval — AC1: "30s for high-urgency, up to 15 minutes for baseline
// rules". A rule's time budget is simply its own interval: if it cannot
// finish inside the period it is scheduled to repeat at, it is by
// definition exceeding its budget (AC4), and the structural
// never-overlaps property below depends on each run actually finishing
// (or being killed) before the next tick matters anyway.
func levelInterval(level string) time.Duration {
	switch level {
	case "critical", "high":
		return 30 * time.Second
	case "medium":
		return 5 * time.Minute
	default:
		return 15 * time.Minute
	}
}

type scheduledRule struct {
	query    *CompiledQuery
	interval time.Duration
}

// Scheduler runs every windowed rule's compiled query on its own ticker.
//
// Overlap prevention (AC3) is structural, not a lock: mirrors
// go/sentinelconnector.Scheduler's own established shape in this repo —
// one goroutine, one ticker, per registration, and the next tick is never
// even looked at until the current run's query has returned (succeeded,
// failed, or been killed for exceeding its budget). A `time.Ticker`
// drops a tick that fires while its receiver is still busy rather than
// queuing it, which is exactly "an overlapping execution never starts"
// rather than "an overlapping execution is blocked and queued."
type Scheduler struct {
	rules    []scheduledRule
	conn     driver.Conn
	producer *kgo.Client
	log      *slog.Logger
	metrics  Metrics
}

// New compiles every windowed rule in rules (sigmac.EngineInStream rules
// are silently skipped — this is the windowed engine's own counterpart to
// services/detect/internal/worker's own Engine filter) and fails loudly
// if any windowed rule's query cannot be built (AC4's own doctrine,
// applied at startup rather than per-tick).
func New(rules []*sigmac.Rule, conn driver.Conn, producer *kgo.Client, opts Options) (*Scheduler, error) {
	log := opts.Log
	if log == nil {
		log = slog.Default()
	}
	s := &Scheduler{conn: conn, producer: producer, log: log, metrics: opts.Metrics}
	for _, r := range rules {
		if r.Engine != sigmac.EngineWindowed {
			continue
		}
		q, err := BuildQuery(r)
		if err != nil {
			return nil, fmt.Errorf("windowed: compiling rule %s: %w", r.ID, err)
		}
		s.rules = append(s.rules, scheduledRule{query: q, interval: levelInterval(r.Level)})
	}
	return s, nil
}

// Run blocks until ctx is cancelled, running every compiled rule on its
// own ticker concurrently.
func (s *Scheduler) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, sr := range s.rules {
		wg.Add(1)
		go func(sr scheduledRule) {
			defer wg.Done()
			s.runLoop(ctx, sr)
		}(sr)
	}
	wg.Wait()
}

func (s *Scheduler) runLoop(ctx context.Context, sr scheduledRule) {
	ticker := time.NewTicker(sr.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Re-check after the select unblocks: a tick buffered right
			// as shutdown was requested must not start a new run — the
			// same guard go/sentinelconnector.Scheduler's own runLoop
			// uses for the identical reason.
			if ctx.Err() != nil {
				return
			}
			s.runOnce(ctx, sr)
		}
	}
}

// runOnce executes one rule's query, bounded by its own interval as the
// kill budget (AC4), and publishes a Signal per result row. A panic here
// (a driver bug, a scan type mismatch) is recovered so one rule can never
// take down every other rule's own ticker loop — the same per-registration
// isolation go/sentinelconnector.Scheduler's own runOnce already applies.
func (s *Scheduler) runOnce(ctx context.Context, sr scheduledRule) {
	defer func() {
		if p := recover(); p != nil {
			s.log.Error("windowed rule panicked", "rule_id", sr.query.Rule.ID, "panic", p)
		}
	}()

	now := time.Now().UTC()
	windowStart := now.Add(-sr.query.Rule.Aggregation.Window)

	qctx, cancel := context.WithTimeout(ctx, sr.interval)
	defer cancel()

	rows, err := s.conn.Query(qctx, sr.query.SQL, sr.query.Args(windowStart, now)...)
	if err != nil {
		if qctx.Err() == context.DeadlineExceeded {
			s.log.Error("windowed rule killed: exceeded its time budget", "rule_id", sr.query.Rule.ID, "budget", sr.interval, "err", err)
			if s.metrics.QueryKilled != nil {
				s.metrics.QueryKilled.Add(ctx, 1, metric.WithAttributes(attribute.String("rule_id", sr.query.Rule.ID)))
			}
			return
		}
		s.log.Error("windowed rule query failed", "rule_id", sr.query.Rule.ID, "err", err)
		if s.metrics.QueryErrors != nil {
			s.metrics.QueryErrors.Add(ctx, 1, metric.WithAttributes(attribute.String("rule_id", sr.query.Rule.ID)))
		}
		return
	}
	defer rows.Close()

	signals, err := scanSignals(rows, sr.query.Rule, now)
	if err != nil {
		s.log.Error("scanning windowed result rows", "rule_id", sr.query.Rule.ID, "err", err)
	}

	for _, sig := range signals {
		if err := s.publishSignal(ctx, sig); err != nil {
			s.log.Error("publishing windowed signal failed", "rule_id", sr.query.Rule.ID, "tenant_id", sig.TenantID, "err", err)
		} else if s.metrics.SignalsEmitted != nil {
			s.metrics.SignalsEmitted.Add(ctx, 1, metric.WithAttributes(attribute.String("rule_id", sr.query.Rule.ID)))
		}

		// P2-08/TG4: the critical bypass — see
		// services/detect/internal/worker's identical logic for the
		// in-stream engine. Unconditional on the signals publish above,
		// and makes no call of any kind into correlation, the analyst,
		// or an LLM provider.
		if sig.Severity == levelCritical {
			if err := s.publishCriticalAlert(ctx, sig); err != nil {
				s.log.Error("publishing windowed critical alert failed", "rule_id", sr.query.Rule.ID, "tenant_id", sig.TenantID, "err", err)
			} else if s.metrics.CriticalAlertsEmitted != nil {
				s.metrics.CriticalAlertsEmitted.Add(ctx, 1, metric.WithAttributes(attribute.String("rule_id", sr.query.Rule.ID)))
			}
		}
	}
}

// scanSignals is runOnce's pure core: turn query result rows into Signal
// values, with no Kafka or metrics side effect — the same
// "handleRecord/evaluate" split services/detect/internal/worker already
// uses, for the same reason: this is what a unit test can exercise
// directly against a fake driver.Rows, without a real producer.
//
// A row this function cannot scan is logged by the caller and simply
// excluded — one malformed result row must not discard every other row
// the same query legitimately produced.
func scanSignals(rows driver.Rows, r *sigmac.Rule, now time.Time) ([]sentinelsignal.Signal, error) {
	entityType := entityTypeFromGroupField(r.Aggregation.GroupBy[0])

	var signals []sentinelsignal.Signal
	var scanErr error
	for rows.Next() {
		var tenantID, groupKey string
		// count()/count(DISTINCT ...) are ClickHouse UInt64, not Int64 —
		// clickhouse-go's Scan rejects the signed type outright rather
		// than silently truncating, which is how this was caught.
		var aggValue uint64
		var eventIDs []string
		if err := rows.Scan(&tenantID, &groupKey, &aggValue, &eventIDs); err != nil {
			scanErr = err
			continue
		}
		signals = append(signals, sentinelsignal.Signal{
			SignalID:         uuid.NewString(),
			EventIDs:         eventIDs,
			TenantID:         tenantID,
			RuleID:           r.ID,
			RuleTitle:        r.Title,
			MitreIDs:         r.MitreIDs,
			Severity:         r.Level,
			Engine:           "windowed",
			EntityType:       entityType,
			EntityID:         groupKey,
			OwnerDescription: r.OwnerDescription,
			DedupeKey:        sentinelsignal.NewDedupeKey(tenantID, r.ID, groupKey, eventIDs),
			DetectedAt:       now,
		})
	}
	if err := rows.Err(); err != nil {
		scanErr = err
	}
	return signals, scanErr
}

func (s *Scheduler) publishSignal(ctx context.Context, sig sentinelsignal.Signal) error {
	payload, err := json.Marshal(sig)
	if err != nil {
		return err
	}
	// tenant_id:entity_id — unlike the in-stream worker (P2-04), a
	// windowed signal already has a real entity (the group-by key), so
	// this is the actual tenant_id:entity_id key signals' own TopicSpec
	// declares (go/sentinelstream.TopicSpec), not a stand-in.
	key := sig.TenantID + ":" + sig.EntityID
	res := s.producer.ProduceSync(ctx, &kgo.Record{Topic: sentinelstream.Signals, Key: []byte(key), Value: payload})
	return res.FirstErr()
}

// publishCriticalAlert is P2-08/TG4's direct alert path for the windowed
// engine — the identical Signal already published to `signals`,
// published a second time to `alerts.critical` over the same producer
// client, with no dependency of any kind on correlation, the analyst,
// or an LLM provider (AC2).
func (s *Scheduler) publishCriticalAlert(ctx context.Context, sig sentinelsignal.Signal) error {
	payload, err := json.Marshal(sig)
	if err != nil {
		return err
	}
	key := sig.TenantID + ":" + sig.DedupeKey
	res := s.producer.ProduceSync(ctx, &kgo.Record{Topic: sentinelstream.CriticalAlerts, Key: []byte(key), Value: payload})
	return res.FirstErr()
}

// entityTypeFromGroupField derives a human-meaningful entity type from
// the aggregation's own group-by field name — every rule in today's
// corpus groups by "UserId", so this is deliberately a small heuristic
// (strip a trailing Id/ID, lowercase) rather than a maintained table; a
// group-by field this heuristic produces a poor label for is still a
// valid, harmless string (EntityType is descriptive metadata, not a
// correctness-bearing value), not a reason to fail the query.
func entityTypeFromGroupField(field string) string {
	trimmed := strings.TrimSuffix(strings.TrimSuffix(field, "Id"), "ID")
	if trimmed == "" {
		return strings.ToLower(field)
	}
	return strings.ToLower(trimmed)
}
