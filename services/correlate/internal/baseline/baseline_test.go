package baseline

import "testing"

// T1: a habitual value is correctly identified from seeded history.
// (The seeding itself — real ClickHouse aggregation — is proven
// separately by store_integration_test.go; this tests the threshold
// and usual-value logic that sits on top of whatever the aggregation
// returns.)
func TestEvaluate_IdentifiesHabitualValueFromSeededHistory(t *testing.T) {
	b := evaluate(MetricCountry, rawAggregate{Observations: 50, TopValues: []string{"US", "RU"}})
	if !b.Valid {
		t.Fatal("expected a valid baseline at 50 observations")
	}
	if !b.IsUsualValue("US") {
		t.Error("US is the most frequent seeded value and should be usual")
	}
	if b.IsUsualValue("DE") {
		t.Error("DE never appeared in the seeded history and should not be usual")
	}
	if b.IsAnomalous("US") {
		t.Error("a usual value should not be anomalous")
	}
	if !b.IsAnomalous("DE") {
		t.Error("a never-seen value should be anomalous against a valid baseline")
	}
}

// T2: an entity below the observation threshold returns
// insufficient-data rather than a baseline.
func TestEvaluate_BelowThresholdReturnsInsufficientData(t *testing.T) {
	b := evaluate(MetricCountry, rawAggregate{Observations: MinObservations - 1, TopValues: []string{"US"}})
	if b.Valid {
		t.Fatal("expected an invalid baseline below the observation threshold")
	}
	if b.UsualValues != nil {
		t.Error("an invalid baseline should not populate UsualValues")
	}
}

func TestEvaluate_AtExactlyTheThresholdIsValid(t *testing.T) {
	b := evaluate(MetricCountry, rawAggregate{Observations: MinObservations, TopValues: []string{"US"}})
	if !b.Valid {
		t.Error("expected a valid baseline at exactly the threshold")
	}
}

// T4 (pure half): a new entity's insufficient history is never treated
// as anomalous by default — true for every value, categorical or
// numeric, regardless of what's asked.
func TestBaseline_InvalidBaselineIsNeverAnomalous(t *testing.T) {
	b := evaluate(MetricCountry, rawAggregate{Observations: 2, TopValues: []string{"US"}})
	for _, v := range []string{"US", "RU", "a-country-never-seen-at-all"} {
		if b.IsAnomalous(v) {
			t.Errorf("IsAnomalous(%q) = true for an invalid baseline, want false", v)
		}
		if b.IsUsualValue(v) {
			t.Errorf("IsUsualValue(%q) = true for an invalid baseline, want false", v)
		}
	}
}

func TestEvaluate_DataVolumePopulatesQuantilesNotUsualValues(t *testing.T) {
	b := evaluate(MetricDataVolume, rawAggregate{Observations: 40, Quantiles: []float64{100, 500, 900}})
	if !b.Valid {
		t.Fatal("expected a valid baseline")
	}
	if b.UsualValues != nil {
		t.Error("MetricDataVolume should never populate UsualValues")
	}
	if b.Volume == nil {
		t.Fatal("expected Volume to be populated")
	}
	if b.Volume.P50 != 100 || b.Volume.P95 != 500 || b.Volume.P99 != 900 {
		t.Errorf("got Volume %+v, want {100 500 900}", *b.Volume)
	}
}

func TestBaseline_IsVolumeAnomalous(t *testing.T) {
	b := evaluate(MetricDataVolume, rawAggregate{Observations: 40, Quantiles: []float64{100, 500, 900}})
	if b.IsVolumeAnomalous(900) {
		t.Error("exactly P99 should not itself be anomalous")
	}
	if !b.IsVolumeAnomalous(901) {
		t.Error("a value above P99 should be anomalous")
	}

	insufficient := evaluate(MetricDataVolume, rawAggregate{Observations: 1})
	if insufficient.IsVolumeAnomalous(1_000_000) {
		t.Error("an invalid baseline must never report a volume as anomalous")
	}
}
