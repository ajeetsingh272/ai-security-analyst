// Package baseline is P3-05: per-entity behavioural baselines — usual
// countries, ASNs, devices, sign-in hours, and typical data-transfer
// volume — computed from sentinel.events (ClickHouse) over a rolling
// 30-day window, and exposed as a plain, callable Go function. This is
// deliberately the future `get_entity_baseline(entity, metric)`
// investigation tool (docs/architecture/overview.md §3.7) ahead of any
// tool-calling framework existing to invoke it — no such framework
// exists anywhere in this repo yet (apps/analyst is an empty stub), so
// this package's job is to be the correct, well-documented function a
// later phase wires in, not to build that framework itself.
//
// GetBaseline/Recompute (store.go) are the thin, ClickHouse-aware
// shell; everything in THIS file is pure — no I/O — so T1/T2 (a
// habitual value is correctly identified; an under-threshold entity
// returns insufficient-data rather than a baseline) run with no
// database at all, against a rawAggregate built by hand.
package baseline

// Metric is one of the five dimensions AC1 names. entity_id in
// sentinel.entity_baselines is the raw OCSF actor_user_uid — the same
// user-identity space services/correlate/internal/cluster already
// keys its own raw (entity_type="user", entity_id) pairs on — not
// internal/entity's own resolved identity graph (the same scope
// boundary P3-04's entity_criticality drew, for the same reason:
// unifying the two is separate, not-yet-done work).
type Metric string

const (
	MetricCountry    Metric = "country"
	MetricASN        Metric = "asn"
	MetricDevice     Metric = "device"
	MetricSignInHour Metric = "sign_in_hour"
	MetricDataVolume Metric = "data_volume"
)

// Window is AC2's own "rolling 30-day window".
const Window = 30 // days

// MinObservations is AC2's own "minimum-observation threshold before a
// baseline is considered valid" — chosen so a handful of events (a
// brand new hire's first day, a handful of after-hours logins) can
// never masquerade as an established pattern. Not configurable per
// tenant: this is a statistical floor, not a product/billing knob the
// way scoring's own escalation threshold is.
const MinObservations = 20

// VolumeStats is the data-transfer-volume metric's own numeric shape —
// quantiles, not a usual-values list, since "typical volume" is a
// magnitude, not a category.
type VolumeStats struct {
	P50, P95, P99 float64
}

// Baseline is one entity's behavioural baseline for one Metric.
type Baseline struct {
	Metric       Metric
	Observations uint64
	// Valid is false when Observations < MinObservations — AC3's own
	// "a new entity with insufficient history is explicitly marked as
	// such". UsualValues and Volume are both left at their zero value
	// when Valid is false: there is nothing to report, not a guess.
	Valid bool
	// UsualValues is the metric's own most frequent observed values,
	// most frequent first — set for every metric except
	// MetricDataVolume, which has no categorical "usual value" at all.
	UsualValues []string
	// Volume is set only for MetricDataVolume.
	Volume *VolumeStats
}

// IsUsualValue reports whether value is among this baseline's own
// known-usual values (T1: "correctly identifies a habitual ... value
// from seeded history"). Always false for an invalid baseline — AC3's
// "never treated as anomalous by default" means the converse question
// ("is this unusual") must also never silently default to "yes"
// simply because nothing is known yet.
func (b Baseline) IsUsualValue(value string) bool {
	if !b.Valid {
		return false
	}
	for _, v := range b.UsualValues {
		if v == value {
			return true
		}
	}
	return false
}

// IsAnomalous is the direct negation callers actually want to ask —
// "should this value raise an eyebrow" — rather than re-deriving it
// from IsUsualValue themselves and risking getting the invalid-
// baseline case backwards. AC3/T4: an invalid (insufficient-history)
// baseline reports false for every value, never true by default.
func (b Baseline) IsAnomalous(value string) bool {
	return b.Valid && !b.IsUsualValue(value)
}

// IsVolumeAnomalous reports whether value exceeds this baseline's own
// historical 99th percentile — the same "never anomalous without a
// valid baseline" guarantee IsAnomalous gives categorical metrics,
// applied to a magnitude instead of a category.
func (b Baseline) IsVolumeAnomalous(value float64) bool {
	if !b.Valid || b.Volume == nil {
		return false
	}
	return value > b.Volume.P99
}

// rawAggregate is exactly what a ClickHouse merge query returns for
// one (tenant, entity, metric) — the seam between this file's pure
// evaluation and store.go's own I/O.
type rawAggregate struct {
	Observations uint64
	TopValues    []string
	Quantiles    []float64 // [p50, p95, p99] — only for MetricDataVolume
}

// evaluate turns one rawAggregate into a Baseline — the only place
// MinObservations is actually applied.
func evaluate(metric Metric, raw rawAggregate) Baseline {
	b := Baseline{Metric: metric, Observations: raw.Observations}
	if raw.Observations < MinObservations {
		return b // AC3: Valid stays false, nothing else is populated
	}
	b.Valid = true
	if metric == MetricDataVolume {
		if len(raw.Quantiles) == 3 {
			b.Volume = &VolumeStats{P50: raw.Quantiles[0], P95: raw.Quantiles[1], P99: raw.Quantiles[2]}
		}
		return b
	}
	b.UsualValues = raw.TopValues
	return b
}
