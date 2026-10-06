// Package worker is P2-04: the in-stream detection runtime. It consumes
// events.normalized, narrows candidates through the dispatch tree (P2-03),
// calls each candidate's compiled predicate (P2-02), and publishes a
// Signal for every match to the `signals` topic — with offsets committed
// only after every record in a poll has been durably handled (ADR-0010's
// commit-after-ack discipline, the same shape go/sentinelevents.Consumer
// already uses for its own Kafka-to-ClickHouse path).
package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelenrich"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelsignal"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/detectgen"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/dispatch"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/suppression"
	"github.com/google/uuid"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// engineInStream matches detectgen.CompiledRule.Engine's string form for an
// in-stream rule (sigmac.EngineInStream.String()) — duplicated as a literal
// rather than importing sigmac just for this one constant, the same
// "compiled output is the contract, not the IR" boundary P2-02 already
// draws between sigmac and detectgen.
const engineInStream = "in-stream"

// engineHotfix marks a Signal as sourced from P2-12's own interpreted
// hotfix-rule path rather than the compiled corpus — informational only
// (sentinelsignal.Signal.Engine has no other reader that branches on
// this string), so a dashboard or correlation consumer can tell the two
// apart without needing a separate topic or field.
const engineHotfix = "hotfix"

// levelCritical is the one rule Level value that triggers the direct
// alert bypass (P2-08, SECURITY.md guarantee #4: "Critical alerts
// survive AI outage"). Matches Sigma's own `level: critical` value
// verbatim — a rule author sets this in YAML, nothing here infers it.
const levelCritical = "critical"

// wireEvent mirrors go/sentinelconnector/publisher.go's own wireEvent — the
// one JSON shape actually on events.normalized's wire, field for field.
// Kept local rather than imported: this package has no business depending
// on the connector framework just to read a JSON shape, the same reasoning
// go/sentinelevents.EventRow already applies on that topic's other
// consumer.
type wireEvent struct {
	TenantID      string            `json:"tenant_id"`
	EventID       string            `json:"event_id"`
	Time          time.Time         `json:"time"`
	SchemaVersion string            `json:"schema_version"`
	ClassUID      uint32            `json:"class_uid"`
	CategoryUID   uint16            `json:"category_uid"`
	ActivityID    uint16            `json:"activity_id"`
	TypeUID       uint32            `json:"type_uid"`
	SeverityID    uint8             `json:"severity_id"`
	Metadata      map[string]string `json:"metadata,omitempty"`
	Unmapped      map[string]string `json:"unmapped,omitempty"`
}

// Enricher is the one method services/detect/internal/worker needs from
// go/sentinelenrich.Refresher — narrowed to an interface at this,
// the consumer, so a unit test can inject a trivial fake instead of a
// real Refresher with real cached feeds. A nil Enricher (the default —
// see Options) simply means no enrichment fields are attached; it is
// never required.
type Enricher interface {
	Lookup(ip string) sentinelenrich.Classification
}

// HotfixRules is the one method worker needs from
// services/detect/internal/hotfix.Loader — narrowed to an interface at
// this, the consumer, so a unit test can inject a trivial fake instead
// of a real Loader with a real Postgres-backed source. A nil
// HotfixRules (the default — see Options) simply means no hotfix rules
// ever evaluate; it is never required.
type HotfixRules interface {
	Active() []*sigmac.Rule
}

// flatten turns a wire event into the flat map[string]string every
// compiled predicate and the dispatch tree actually read (sigmac.Event is
// exactly this type) — the OCSF-path keys fieldmap.go's own table
// promises: bare names for typed fields, "metadata.<k>"/"unmapped.<k>" for
// the two map fields. enricher, if non-nil, additionally attaches P2-09's
// own threat-intel fields (fieldmap.go's IsAnonymousProxy/IsVPN/
// IsHostingProvider/GeoCountry/GeoASN) keyed off whichever client-IP
// field the event actually carries — this IS "enrichment time" (AC2):
// the one and only place in the in-stream path an event's own ClientIP
// is resolved against the locally cached feeds, synchronously, in
// memory, before any rule ever sees the event (AC1 — Enricher.Lookup
// never touches the network itself, see sentinelenrich.Refresher's own
// doc comment).
func flatten(ev wireEvent, enricher Enricher) map[string]string {
	flat := map[string]string{
		"tenant_id":    ev.TenantID,
		"class_uid":    strconv.FormatUint(uint64(ev.ClassUID), 10),
		"category_uid": strconv.FormatUint(uint64(ev.CategoryUID), 10),
		"activity_id":  strconv.FormatUint(uint64(ev.ActivityID), 10),
		"severity_id":  strconv.FormatUint(uint64(ev.SeverityID), 10),
		// fieldmap.go's own "EventID" -> "metadata.event_id" entry,
		// honoured here even though no rule in today's corpus uses it yet.
		"metadata.event_id": ev.EventID,
	}
	for k, v := range ev.Metadata {
		flat["metadata."+k] = v
	}
	for k, v := range ev.Unmapped {
		flat["unmapped."+k] = v
	}

	if enricher != nil {
		ip := flat["unmapped.ClientIP"]
		if ip == "" {
			ip = flat["unmapped.ClientIPAddress"]
		}
		if ip != "" {
			c := enricher.Lookup(ip)
			flat["metadata.is_anonymous_proxy"] = strconv.FormatBool(c.Anonymiser())
			flat["metadata.is_vpn"] = strconv.FormatBool(c.IsVPN)
			flat["metadata.is_hosting_provider"] = strconv.FormatBool(c.IsHosting)
			if c.Country != "" {
				flat["metadata.geo_country"] = c.Country
			}
			if c.ASN != 0 {
				flat["metadata.geo_asn"] = strconv.FormatUint(uint64(c.ASN), 10)
			}
		}
	}
	return flat
}

// dlqEnvelope is what actually lands on signals.dlq — enough for a human
// to tell what failed and go look at the source event, mirroring
// services/eventwriter's own DLQ payload shape (log the cause, keep the
// raw bytes, don't invent a second parse of something that already failed
// to parse once).
type dlqEnvelope struct {
	Stage    string          `json:"stage"`
	Error    string          `json:"error"`
	RuleID   string          `json:"rule_id,omitempty"`
	RawEvent json.RawMessage `json:"raw_event"`
}

// Metrics are all optional (nil-safe) — the same pattern every other Go
// service in this repo uses for its own metrics (e.g.
// go/sentinelconnector.Scheduler, services/detect/internal/dispatch.Tree).
type Metrics struct {
	SignalsEmitted metric.Int64Counter
	EvalErrors     metric.Int64Counter
	PartitionLag   metric.Int64Gauge
	// CriticalAlertsEmitted counts the direct-bypass publish (P2-08),
	// separate from SignalsEmitted — the two are independent outcomes of
	// the same signal, and a stakeholder watching TG4's own guarantee
	// needs to see this path's health without the ordinary signal
	// volume drowning it out.
	CriticalAlertsEmitted metric.Int64Counter
}

type Options struct {
	// Group is this worker's consumer-group id — also the group
	// runLagReporter describes to compute per-partition lag.
	Group string
	Log   *slog.Logger
	Metrics
	// Enricher, if set, attaches P2-09's own threat-intel fields to
	// every event with a ClientIP before dispatch (see flatten's own
	// doc comment). Optional and nil-safe like every other capability
	// here — a detect deployment with no enrichment configured simply
	// never populates IsAnonymousProxy/IsVPN/etc., and any rule
	// referencing them legitimately never matches, the same as any
	// other field an event happens not to carry.
	Enricher Enricher
	// SuppressionChecker, if set, is consulted once per emitted signal
	// (P2-10/TG3). A suppressed signal still publishes to `signals`
	// exactly like any other (AC3) — this field only ever gates the
	// P2-08 critical-alert bypass, never the normal publish. Optional
	// and nil-safe; a deployment with no Postgres wiring for suppression
	// simply never suppresses anything, the same as every other optional
	// capability here.
	SuppressionChecker suppression.Checker
	// HotfixRules, if set, is evaluated against every event alongside
	// the compiled corpus (P2-12/ADR-0004's own emergency escape
	// hatch). Optional and nil-safe like every other capability here;
	// a deployment with no Postgres wiring for it simply never has any
	// hotfix rules to evaluate.
	HotfixRules HotfixRules
}

// Worker evaluates events.normalized against tree and publishes matches to
// `signals`. consumer must be joined to a group over events.normalized
// with auto-commit disabled; producer must not be joined to any group —
// it publishes to both `signals` and `signals.dlq`, the same "a dedicated
// client for publishing, separate from the grouped consumer" split
// services/eventwriter's own DLQ client already uses.
type Worker struct {
	tree        *dispatch.Tree
	consumer    *kgo.Client
	producer    *kgo.Client
	group       string
	log         *slog.Logger
	metrics     Metrics
	enricher    Enricher
	suppressor  suppression.Checker
	hotfixRules HotfixRules
}

func New(tree *dispatch.Tree, consumer, producer *kgo.Client, opts Options) *Worker {
	log := opts.Log
	if log == nil {
		log = slog.Default()
	}
	return &Worker{
		tree:        tree,
		consumer:    consumer,
		producer:    producer,
		group:       opts.Group,
		log:         log,
		metrics:     opts.Metrics,
		enricher:    opts.Enricher,
		suppressor:  opts.SuppressionChecker,
		hotfixRules: opts.HotfixRules,
	}
}

// Run polls until ctx is cancelled. Offsets commit once per poll, after
// every record fetched in that poll has been handed either a published
// signal, a DLQ entry, or (a decode failure) a log line — never before, so
// a crash between fetch and commit simply re-delivers the same records to
// whichever worker instance resumes the group next (T2: "replays without
// losing signals" — a possible duplicate signal is an acceptable cost of
// that guarantee, a lost one is not).
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
					w.log.Error("fetch error", "topic", e.Topic, "partition", e.Partition, "err", e.Err)
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
				w.log.Error("committing offsets, will retry next poll", "err", err)
			}
		}
	}
}

func (w *Worker) handleRecord(ctx context.Context, r *kgo.Record) {
	var wev wireEvent
	if err := json.Unmarshal(r.Value, &wev); err != nil {
		w.log.Error("skipping malformed record", "topic", r.Topic, "partition", r.Partition, "offset", r.Offset, "err", err)
		w.toDLQ(ctx, "decode", err, "", r.Value)
		return
	}

	signals, failures := evaluate(ctx, w.tree, wev, w.enricher, w.hotfixRules)

	for _, f := range failures {
		w.log.Error("rule evaluation failed, routing to DLQ", "rule_id", f.RuleID, "event_id", wev.EventID, "err", f.Err)
		if w.metrics.EvalErrors != nil {
			w.metrics.EvalErrors.Add(ctx, 1, metric.WithAttributes(attribute.String("rule_id", f.RuleID)))
		}
		w.toDLQ(ctx, "evaluate", f.Err, f.RuleID, r.Value)
	}

	for _, sig := range signals {
		// P2-10/TG3: checked once, before either publish, so the
		// suppression disclosure (sig.Suppressed/SuppressionID) reaches
		// the normal `signals` publish too — AC3's "still stored and
		// counted" means the stored record itself says whether it was
		// suppressed, not just that the bypass silently didn't fire.
		// A lookup failure (e.g. Postgres unreachable) fails OPEN —
		// treated as not-suppressed, logged, never blocking either
		// publish — the same "no dependency" principle AC2 already
		// established for the bypass: a suppression-store outage must
		// never be a way to silence a critical alert.
		if w.suppressor != nil {
			suppressed, suppressionID, err := w.suppressor.IsSuppressed(ctx, sig.TenantID, sig.RuleID, sig.EntityID)
			if err != nil {
				w.log.Error("checking suppression failed, treating as not suppressed", "rule_id", sig.RuleID, "err", err)
			} else if suppressed {
				sig.Suppressed = true
				sig.SuppressionID = suppressionID
			}
		}

		if err := w.publishSignal(ctx, sig); err != nil {
			w.log.Error("publishing signal failed, routing to DLQ", "rule_id", sig.RuleID, "event_id", wev.EventID, "err", err)
			w.toDLQ(ctx, "publish", err, sig.RuleID, r.Value)
		} else if w.metrics.SignalsEmitted != nil {
			w.metrics.SignalsEmitted.Add(ctx, 1, metric.WithAttributes(attribute.String("rule_id", sig.RuleID)))
		}

		// P2-08/TG4: the critical bypass. Never gated on the signals
		// publish above — AC1's own "in parallel with entering
		// correlation" means this runs unconditionally, whether that
		// publish just succeeded, failed, or the whole correlation
		// plane is down for unrelated reasons this worker never
		// observes (AC2: "no dependency on correlation, the analyst,
		// or the LLM provider" — this call never touches any of them).
		// The ONE new gate, from P2-10: a suppressed critical signal
		// is still stored above, but does not escalate (AC3).
		if sig.Severity == levelCritical && !sig.Suppressed {
			if err := w.publishCriticalAlert(ctx, sig); err != nil {
				w.log.Error("publishing critical alert failed, routing to DLQ", "rule_id", sig.RuleID, "event_id", wev.EventID, "err", err)
				w.toCriticalAlertDLQ(ctx, err, sig)
			} else if w.metrics.CriticalAlertsEmitted != nil {
				w.metrics.CriticalAlertsEmitted.Add(ctx, 1, metric.WithAttributes(attribute.String("rule_id", sig.RuleID)))
			}
		}
	}
}

// ruleFailure is one candidate rule's evaluation panic, carried out of
// evaluate so the caller decides what to do with it (log, metric, DLQ) —
// evaluate itself touches no I/O, which is what makes it unit-testable
// without a broker (T4).
type ruleFailure struct {
	RuleID string
	Err    error
}

// evaluate is handleRecord's pure core: flatten the event, narrow to
// candidates via the dispatch tree, and call each candidate's compiled
// predicate. Deliberately free of any Kafka/DLQ/metrics side effect so
// T4 ("an evaluation panic is recovered, routed to DLQ, and the worker
// continues") can be proven directly against a tree and an event, with no
// broker involved — handleRecord is the thin, integration-tested layer
// that turns this function's output into wire effects.
func evaluate(ctx context.Context, tree *dispatch.Tree, wev wireEvent, enricher Enricher, hotfixRules HotfixRules) (signals []sentinelsignal.Signal, failures []ruleFailure) {
	flat := flatten(wev, enricher)
	for _, c := range tree.Candidates(ctx, flat) {
		// This is the IN-STREAM worker (P2-04's own title) — a "windowed"
		// rule's compiled predicate only checks its base selection, never
		// the count/within clause (that's the separate windowed engine's
		// own job, ADR-0004 §3.5, not yet built). Evaluating it here would
		// emit a premature signal on the FIRST qualifying event rather than
		// the Nth within the window. The dispatch tree itself stays
		// engine-agnostic on purpose (tree.go's own doc comment) so that
		// future windowed worker can reuse it — this filter is this
		// worker's concern, not the tree's.
		if c.Engine != engineInStream {
			continue
		}
		matched, err := safeMatch(c, flat)
		if err != nil {
			failures = append(failures, ruleFailure{RuleID: c.ID, Err: err})
			continue
		}
		if !matched {
			continue
		}
		eventIDs := []string{wev.EventID}
		signals = append(signals, sentinelsignal.Signal{
			SignalID:         uuid.NewString(),
			EventIDs:         eventIDs,
			TenantID:         wev.TenantID,
			RuleID:           c.ID,
			RuleTitle:        c.Title,
			MitreIDs:         c.MitreIDs,
			Severity:         c.Level,
			Engine:           c.Engine,
			OwnerDescription: c.OwnerDescription,
			DedupeKey:        sentinelsignal.NewDedupeKey(wev.TenantID, c.ID, "", eventIDs),
			DetectedAt:       time.Now().UTC(),
		})
	}

	// P2-12/ADR-0004: the emergency hotfix path. Every active hotfix
	// rule is checked against every event, the same as the compiled
	// corpus — there are at most 10 of these at once (AC1), so no
	// dispatch-tree-style narrowing is worth the complexity for this
	// path specifically. Dispatch narrowing stays the compiled corpus's
	// own optimization, not something this small, deliberately-
	// constrained escape hatch needs to share.
	if hotfixRules != nil {
		for _, r := range hotfixRules.Active() {
			matched, err := safeEvaluateHotfix(r, flat)
			if err != nil {
				failures = append(failures, ruleFailure{RuleID: r.ID, Err: err})
				continue
			}
			if !matched {
				continue
			}
			eventIDs := []string{wev.EventID}
			signals = append(signals, sentinelsignal.Signal{
				SignalID:         uuid.NewString(),
				EventIDs:         eventIDs,
				TenantID:         wev.TenantID,
				RuleID:           r.ID,
				RuleTitle:        r.Title,
				MitreIDs:         r.MitreIDs,
				Severity:         r.Level,
				Engine:           engineHotfix,
				OwnerDescription: r.OwnerDescription,
				DedupeKey:        sentinelsignal.NewDedupeKey(wev.TenantID, r.ID, "", eventIDs),
				DetectedAt:       time.Now().UTC(),
			})
		}
	}

	return signals, failures
}

// safeEvaluateHotfix mirrors safeMatch's own panic recovery (T4's own
// doctrine, applied here too): a hotfix rule is operator-submitted YAML
// that reached production without the normal PR review a compiled rule
// gets, so a bug in one must not be able to take down evaluation for
// every other candidate — compiled OR hotfix — against the same event.
func safeEvaluateHotfix(r *sigmac.Rule, ev sigmac.Event) (matched bool, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("hotfix rule %s panicked: %v", r.ID, p)
		}
	}()
	return sigmac.Evaluate(r, ev), nil
}

// safeMatch recovers a panicking predicate (T4) at the single-rule
// granularity — a bug in one rule's compiled Matches must not prevent
// every OTHER candidate rule from still being checked against the same
// event, and must never propagate up into Run's own poll loop (which
// would stop the whole worker, not just skip one rule).
func safeMatch(c detectgen.CompiledRule, ev map[string]string) (matched bool, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("rule %s panicked: %v", c.ID, p)
		}
	}()
	return c.Matches(ev), nil
}

func (w *Worker) publishSignal(ctx context.Context, sig sentinelsignal.Signal) error {
	payload, err := json.Marshal(sig)
	if err != nil {
		return err
	}
	// tenant_id:event_id stands in for signals' declared tenant_id:entity_id
	// key (go/sentinelstream.TopicSpec) until an actual entity concept
	// exists — that resolution is the correlation plane's own job (P3),
	// not this ticket's. This at least keeps every signal for the same
	// event on one partition, in order. EventIDs[0] because an in-stream
	// signal always has exactly one.
	key := sig.TenantID + ":" + sig.EventIDs[0]
	res := w.producer.ProduceSync(ctx, &kgo.Record{Topic: sentinelstream.Signals, Key: []byte(key), Value: payload})
	return res.FirstErr()
}

// publishCriticalAlert is P2-08/TG4's own direct alert path — the exact
// same Signal already built for `signals`, published a second time to
// `alerts.critical` over the same producer client. No RPC, lookup, or
// health check against correlation, the analyst, or any LLM provider
// happens anywhere in this call: that absence, not a try/catch around a
// dependency, is what "no dependency" (AC2) actually means here.
func (w *Worker) publishCriticalAlert(ctx context.Context, sig sentinelsignal.Signal) error {
	payload, err := json.Marshal(sig)
	if err != nil {
		return err
	}
	key := sig.TenantID + ":" + sig.DedupeKey
	res := w.producer.ProduceSync(ctx, &kgo.Record{Topic: sentinelstream.CriticalAlerts, Key: []byte(key), Value: payload})
	return res.FirstErr()
}

func (w *Worker) toCriticalAlertDLQ(ctx context.Context, cause error, sig sentinelsignal.Signal) {
	payload, err := json.Marshal(sig)
	if err != nil {
		w.log.Error("marshalling critical alert for DLQ", "rule_id", sig.RuleID, "err", err)
		return
	}
	env := dlqEnvelope{Stage: "publish-critical-alert", Error: cause.Error(), RuleID: sig.RuleID, RawEvent: json.RawMessage(payload)}
	envPayload, err := json.Marshal(env)
	if err != nil {
		w.log.Error("marshalling critical alert DLQ envelope", "rule_id", sig.RuleID, "err", err)
		return
	}
	dlqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	res := w.producer.ProduceSync(dlqCtx, &kgo.Record{Topic: sentinelstream.CriticalAlertsDLQ, Value: envPayload})
	if err := res.FirstErr(); err != nil {
		w.log.Error("publishing critical alert to DLQ failed", "rule_id", sig.RuleID, "err", err)
	}
}

func (w *Worker) toDLQ(ctx context.Context, stage string, cause error, ruleID string, raw []byte) {
	env := dlqEnvelope{Stage: stage, Error: cause.Error(), RuleID: ruleID, RawEvent: json.RawMessage(raw)}
	payload, err := json.Marshal(env)
	if err != nil {
		w.log.Error("marshalling DLQ envelope", "stage", stage, "err", err)
		return
	}
	dlqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	res := w.producer.ProduceSync(dlqCtx, &kgo.Record{Topic: sentinelstream.SignalsDLQ, Value: payload})
	if err := res.FirstErr(); err != nil {
		w.log.Error("publishing to DLQ failed", "stage", stage, "err", err)
	}
}

// RunLagReporter polls the consumer group's own per-partition lag on a
// ticker and records it — AC: "consumer lag is exported per partition".
// Run as its own goroutine alongside Run; returns when ctx is cancelled.
func (w *Worker) RunLagReporter(ctx context.Context, topic string, interval time.Duration) {
	if w.metrics.PartitionLag == nil {
		return
	}
	adm := kadm.NewClient(w.consumer)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			lags, err := adm.Lag(ctx, w.group)
			if err != nil {
				w.log.Error("fetching consumer lag", "group", w.group, "err", err)
				continue
			}
			gl, ok := lags[w.group]
			if !ok || gl.Error() != nil {
				continue
			}
			for partition, memberLag := range gl.Lag[topic] {
				w.metrics.PartitionLag.Record(ctx, memberLag.Lag, metric.WithAttributes(
					attribute.String("topic", topic),
					attribute.Int("partition", int(partition)),
				))
			}
		}
	}
}
