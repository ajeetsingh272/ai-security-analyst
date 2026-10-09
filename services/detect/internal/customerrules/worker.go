package customerrules

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelsignal"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
	"github.com/google/uuid"
	"github.com/twmb/franz-go/pkg/kgo"
)

// engineCustomerRule marks a Signal as sourced from this path, exactly
// as worker.engineInStream/engineHotfix already mark theirs — purely
// informational (nothing branches on it), so a dashboard or
// correlation consumer can tell the three apart.
const engineCustomerRule = "customer_rule"

// evaluationBudget is ADR-0012 §2's own number: a single evaluation
// exceeding this is "slow", counted by SuspensionTracker. 5ms, not a
// tighter bound, because it must comfortably exceed the cost of a
// legitimate rule at validate.go's own complexity ceiling (20
// selections, RE2 regex) under ordinary load — this is a defense-in-
// depth backstop, not the primary safety mechanism (see ADR-0012 §1/§2).
const evaluationBudget = 5 * time.Millisecond

// wireEvent mirrors worker.wireEvent field-for-field (this package has
// no business depending on services/detect/internal/worker just to
// read one JSON shape — the identical reasoning worker.go itself gives
// for not depending on the connector framework).
type wireEvent struct {
	TenantID    string            `json:"tenant_id"`
	EventID     string            `json:"event_id"`
	ClassUID    uint32            `json:"class_uid"`
	CategoryUID uint16            `json:"category_uid"`
	ActivityID  uint16            `json:"activity_id"`
	SeverityID  uint8             `json:"severity_id"`
	Metadata    map[string]string `json:"metadata,omitempty"`
	Unmapped    map[string]string `json:"unmapped,omitempty"`
}

func flatten(ev wireEvent) map[string]string {
	flat := map[string]string{
		"tenant_id":         ev.TenantID,
		"class_uid":         strconv.FormatUint(uint64(ev.ClassUID), 10),
		"category_uid":      strconv.FormatUint(uint64(ev.CategoryUID), 10),
		"activity_id":       strconv.FormatUint(uint64(ev.ActivityID), 10),
		"severity_id":       strconv.FormatUint(uint64(ev.SeverityID), 10),
		"metadata.event_id": ev.EventID,
	}
	for k, v := range ev.Metadata {
		flat["metadata."+k] = v
	}
	for k, v := range ev.Unmapped {
		flat["unmapped."+k] = v
	}
	return flat
}

// RuleProvider is what evaluate needs from Loader — narrowed to an
// interface at the consumer so evaluate's own test needs no real
// Postgres, the same pattern worker.HotfixRules already uses.
type RuleProvider interface {
	Active(tenantID string) []LoadedRule
}

// ruleOutcome is one rule's own result against one event — TimedOut
// feeds SuspensionTracker; it is NOT whether the rule matched. PanicErr
// is non-nil only if the rule itself panicked (the caller logs it;
// this type stays free of any logging side effect, mirroring
// worker.ruleFailure's identical "pure core reports, the I/O shell
// logs" split).
type ruleOutcome struct {
	RowID    string
	TimedOut bool
	PanicErr error
}

// evaluate is this worker's pure core — no Kafka, no Postgres, no
// metrics — so T1/T2/T3's own proxies can be proven directly against
// a RuleProvider and an event, mirroring worker.evaluate's identical
// "pure core, thin I/O shell" split.
//
// ADR-0012 §4: the tenant-isolation guarantee lives in this one line —
// provider.Active(wev.TenantID) is the ONLY rule set this function
// ever looks at, for the ONE event it was given, which itself already
// belongs to exactly one tenant by the time it reached this function
// (delivered as a single Kafka record). There is no code path here
// that could evaluate a rule against any tenant other than the
// event's own.
func evaluate(provider RuleProvider, wev wireEvent) (signals []sentinelsignal.Signal, outcomes []ruleOutcome) {
	flat := flatten(wev)
	rules := provider.Active(wev.TenantID)

	for _, lr := range rules {
		matched, took, panicErr := safeEvaluate(lr.Rule, flat)
		outcomes = append(outcomes, ruleOutcome{RowID: lr.RowID, TimedOut: took > evaluationBudget, PanicErr: panicErr})
		if !matched {
			continue
		}
		eventIDs := []string{wev.EventID}
		signals = append(signals, sentinelsignal.Signal{
			SignalID:         uuid.NewString(),
			EventIDs:         eventIDs,
			TenantID:         wev.TenantID,
			RuleID:           lr.Rule.ID,
			RuleTitle:        lr.Rule.Title,
			MitreIDs:         lr.Rule.MitreIDs,
			Severity:         lr.Rule.Level,
			Engine:           engineCustomerRule,
			OwnerDescription: lr.Rule.OwnerDescription,
			DedupeKey:        sentinelsignal.NewDedupeKey(wev.TenantID, lr.Rule.ID, "", eventIDs),
			DetectedAt:       time.Now().UTC(),
		})
	}
	return signals, outcomes
}

// safeEvaluate recovers a panicking rule (the same single-rule-
// granularity isolation worker.safeMatch/safeEvaluateHotfix already
// apply) and times the call — the wall-clock half of ADR-0012 §2. A
// panic also forces TimedOut=true: both are "this rule is not safe to
// keep evaluating", and SuspensionTracker's own threshold is the right
// place to act on either, not a second, separate mechanism.
func safeEvaluate(r *sigmac.Rule, ev sigmac.Event) (matched bool, took time.Duration, panicErr error) {
	// Captured before any panic risk: the recovery path below must
	// never itself be able to panic (e.g. by dereferencing r.ID on a
	// nil r) — a second, unrecovered panic INSIDE a recover() handler
	// is not caught by anything and crashes the whole process, exactly
	// the failure mode this function exists to prevent. Caught by this
	// package's own TestEvaluate_PanickingRuleDoesNotBlockOtherRules
	// before it ever shipped.
	ruleID := "(unknown)"
	if r != nil {
		ruleID = r.ID
	}

	start := time.Now()
	defer func() {
		took = time.Since(start)
		if p := recover(); p != nil {
			matched = false
			took = evaluationBudget + 1 // force TimedOut=true on a panic too
			panicErr = fmt.Errorf("customer rule %s panicked: %v", ruleID, p)
		}
	}()
	return sigmac.Evaluate(r, ev), 0, nil
}

// Options mirrors worker.Options' own shape, narrowed to what this
// decoupled path actually needs.
type Options struct {
	Group string
	Log   *slog.Logger
}

// Worker consumes events.normalized under its OWN consumer group
// (ADR-0012 §5) — a second, independent read of the same topic, never
// sharing a goroutine, poll cycle, or group with
// services/detect/internal/worker.Worker. That separation, not a
// shared-resource quota, is what makes a customer rule's own latency
// unable to touch the platform corpus's own SLO.
type Worker struct {
	provider RuleProvider
	tracker  *SuspensionTracker
	consumer *kgo.Client
	producer *kgo.Client
	group    string
	log      *slog.Logger
}

func New(provider RuleProvider, tracker *SuspensionTracker, consumer, producer *kgo.Client, opts Options) *Worker {
	log := opts.Log
	if log == nil {
		log = slog.Default()
	}
	return &Worker{provider: provider, tracker: tracker, consumer: consumer, producer: producer, group: opts.Group, log: log}
}

// Run polls until ctx is cancelled — the identical poll/commit shape
// worker.Worker.Run already uses (offsets commit only after every
// record in a poll has been handled).
func (w *Worker) Run(ctx context.Context) error {
	pollInterval := 1 * time.Second
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		pollCtx, cancel := context.WithTimeout(ctx, pollInterval)
		fetches := w.consumer.PollFetches(pollCtx)
		cancel()

		if errs := fetches.Errors(); len(errs) > 0 {
			for _, e := range errs {
				if e.Err != nil && e.Err != context.DeadlineExceeded && e.Err != context.Canceled {
					w.log.Error("customerrules: fetch error", "topic", e.Topic, "partition", e.Partition, "err", e.Err)
				}
			}
		}

		n := 0
		fetches.EachRecord(func(r *kgo.Record) {
			n++
			w.handleRecord(ctx, r)
		})

		if n > 0 {
			if err := w.consumer.CommitUncommittedOffsets(ctx); err != nil {
				w.log.Error("customerrules: committing offsets, will retry next poll", "err", err)
			}
		}
	}
}

func (w *Worker) handleRecord(ctx context.Context, r *kgo.Record) {
	var wev wireEvent
	if err := json.Unmarshal(r.Value, &wev); err != nil {
		w.log.Error("customerrules: skipping malformed record", "topic", r.Topic, "partition", r.Partition, "offset", r.Offset, "err", err)
		return
	}

	signals, outcomes := evaluate(w.provider, wev)

	for _, o := range outcomes {
		if o.PanicErr != nil {
			w.log.Error("customerrules: rule evaluation panicked, recovered", "tenant_id", wev.TenantID, "row_id", o.RowID, "err", o.PanicErr)
		}
		w.tracker.Record(ctx, wev.TenantID, o.RowID, o.TimedOut)
	}

	for _, sig := range signals {
		// ADR-0012 §6: never the P2-08 critical-alert bypass, regardless
		// of the rule's own declared level — that guarantee is about
		// rules that passed human review before reaching production,
		// which a customer-authored rule has not. Only the ordinary
		// `signals` publish, exactly like any other.
		payload, err := json.Marshal(sig)
		if err != nil {
			w.log.Error("customerrules: marshalling signal", "rule_id", sig.RuleID, "err", err)
			continue
		}
		key := sig.TenantID + ":" + sig.EventIDs[0]
		res := w.producer.ProduceSync(ctx, &kgo.Record{Topic: sentinelstream.Signals, Key: []byte(key), Value: payload})
		if err := res.FirstErr(); err != nil {
			w.log.Error("customerrules: publishing signal failed", "rule_id", sig.RuleID, "event_id", wev.EventID, "err", err)
		}
	}
}
