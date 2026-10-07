// Package noiseratio is P3-09: the P3 exit criterion — "signals
// reduce to escalated cases at least 10:1" — as an executable test,
// replaying a realistic week of data through the real clustering
// (internal/cluster), scoring (internal/scoring) and lifecycle
// (internal/lifecycle) packages against real Postgres.
//
// Deliberately does not replay through Kafka or services/detect's own
// rule engine (unlike go/sentinelreplay, P1-09's own archived-raw-
// event replay tool) — this package's own claim is specifically about
// CORRELATE's behavior at a realistic signal MIX and scale (does
// clustering+scoring+escalation actually collapse noise 10:1 and
// isolate a real attack), not about re-proving Kafka delivery or rule
// matching, both already covered by their own tests. The dataset below
// is built directly as []cluster.Signal, exactly the shape
// cmd/correlate's own consumer hands to Clusterer.Cluster after
// unmarshalling a real wire Signal — skipping the wire hop changes
// nothing about what is actually under test.
package noiseratio

import (
	"fmt"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/services/correlate/internal/cluster"
)

// Real ATT&CK technique IDs (go/sentinelattck's own pinned v19.2
// catalogue, same ones P3-04's own scoring tests use) in two
// different tactics.
const (
	techCredentialAccess = "T1110.003" // credential-access
	techPersistence      = "T1136.003" // persistence
)

// Scale controls how large the replayed dataset is — Reduced for CI
// (fast, still a genuine multi-entity mix), Full for the nightly run
// (closer to a real week's volume). The attack sequence is always
// exactly the same 2 signals regardless of scale: "exactly one
// escalated case" must hold at any size.
type Scale struct {
	// ClusteringEntities each get ClusteringSignalsPerEntity benign
	// signals close together in time — AC1's "benign noise" that
	// clustering is actually expected to reduce (several signals, one
	// case), not just already-isolated singletons.
	ClusteringEntities         int
	ClusteringSignalsPerEntity int
	// SingletonEntities each get exactly one isolated benign signal,
	// spread across the week — noise clustering cannot reduce at all,
	// which is the harder, more realistic case for the 10:1 claim to
	// hold against.
	SingletonEntities int
}

// Reduced is CI-feasible: still exercises every code path (multi-
// signal clustering, singleton cases, the attack), just at a size
// that keeps the whole suite fast.
var Reduced = Scale{ClusteringEntities: 15, ClusteringSignalsPerEntity: 4, SingletonEntities: 20}

// Full is the nightly scale — roughly 10x Reduced's signal volume, a
// closer approximation of "a realistic week" than CI's own budget
// allows on every PR.
var Full = Scale{ClusteringEntities: 150, ClusteringSignalsPerEntity: 4, SingletonEntities: 300}

// AttackCaseEntityID names the one entity the seeded attack sequence
// runs against — exported so a test can assert specifically THIS
// entity's own case escalated, not merely that "some case" did.
const AttackCaseEntityID = "entity-attack-sequence"

// Dataset is a reference week of signals plus which of them belong to
// the one known attack sequence, for assertions that need to
// distinguish "the real attack's own case" from "a benign case that
// happened to score high" (the latter would be a real bug this test
// exists to catch, not something to design around).
type Dataset struct {
	Signals            []cluster.Signal
	AttackEntityID     string
	AttackSignalCount  int
	TotalSignalCount   int
	ClusteringCaseGoal int // how many cases the clustering-entity signals alone should collapse to
	SingletonCaseGoal  int // how many cases the singleton signals alone should collapse to
}

// Build constructs a reference dataset at the given scale, anchored
// so every signal's own DetectedAt falls within one real calendar
// week starting at weekStart.
func Build(scale Scale, weekStart time.Time) Dataset {
	var signals []cluster.Signal

	// Benign, clustering noise: several signals per entity, close
	// together in time (within cluster.DefaultWindow), low severity,
	// a single ATT&CK tactic at most — AC3's own "no benign pattern
	// escalates" needs these to be unambiguously below any plan
	// tier's threshold even after clustering collapses them into one
	// case each.
	for e := 0; e < scale.ClusteringEntities; e++ {
		entityID := fmt.Sprintf("entity-benign-cluster-%d", e)
		// Spread entities across the week, signals within an entity
		// close together — a real "someone had a flurry of ordinary
		// activity on day N" shape, not every entity colliding on
		// the same instant.
		entityBase := weekStart.Add(time.Duration(e%7) * 24 * time.Hour).Add(time.Duration(e) * time.Minute)
		for s := 0; s < scale.ClusteringSignalsPerEntity; s++ {
			signals = append(signals, cluster.Signal{
				DedupeKey: fmt.Sprintf("benign-cluster-%d-%d", e, s), SignalID: fmt.Sprintf("sig-bc-%d-%d", e, s),
				RuleID: "benign-rule", EntityType: "user", EntityID: entityID, Severity: "low",
				EventIDs:   []string{fmt.Sprintf("evt-bc-%d-%d", e, s)},
				DetectedAt: entityBase.Add(time.Duration(s) * 2 * time.Minute),
			})
		}
	}

	// Benign, isolated singletons: one signal, one entity, never
	// clustering with anything else — the harder case for the 10:1
	// ratio, since clustering cannot reduce these at all; only
	// scoring/escalation can keep them out of the numerator.
	for e := 0; e < scale.SingletonEntities; e++ {
		entityID := fmt.Sprintf("entity-benign-singleton-%d", e)
		signals = append(signals, cluster.Signal{
			DedupeKey: fmt.Sprintf("benign-singleton-%d", e), SignalID: fmt.Sprintf("sig-bs-%d", e),
			RuleID: "benign-rule", EntityType: "user", EntityID: entityID, Severity: "medium",
			EventIDs:   []string{fmt.Sprintf("evt-bs-%d", e)},
			DetectedAt: weekStart.Add(time.Duration(e%7)*24*time.Hour + time.Duration(e)*time.Minute),
		})
	}

	// The known attack: a real BEC-shaped sequence (impossible travel,
	// then an inbox rule 90 seconds later — the exact timeline
	// internal/cluster's own BEC integration test already proved
	// collapses to one case), two distinct ATT&CK tactics, severities
	// chosen so the resulting case's score clears every plan tier's
	// escalation threshold with real margin, not by a hair.
	attackBase := weekStart.Add(3*24*time.Hour + 2*time.Hour)
	attackSignals := []cluster.Signal{
		{
			DedupeKey: "attack-1", SignalID: "sig-attack-1", RuleID: "impossible-travel",
			EntityType: "user", EntityID: AttackCaseEntityID, Severity: "critical",
			EventIDs: []string{"evt-attack-1"}, DetectedAt: attackBase,
			MitreIDs: []string{techCredentialAccess},
		},
		{
			DedupeKey: "attack-2", SignalID: "sig-attack-2", RuleID: "new-inbox-rule",
			EntityType: "user", EntityID: AttackCaseEntityID, Severity: "high",
			EventIDs: []string{"evt-attack-2"}, DetectedAt: attackBase.Add(90 * time.Second),
			MitreIDs: []string{techPersistence},
		},
	}
	signals = append(signals, attackSignals...)

	return Dataset{
		Signals:            signals,
		AttackEntityID:     AttackCaseEntityID,
		AttackSignalCount:  len(attackSignals),
		TotalSignalCount:   len(signals),
		ClusteringCaseGoal: scale.ClusteringEntities,
		SingletonCaseGoal:  scale.SingletonEntities,
	}
}
