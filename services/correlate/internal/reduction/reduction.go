// Package reduction is P3-06 (TG3): measuring the signal-to-case
// reduction ratio per tenant per day, and alerting when it degrades
// below 8:1 — the 10:1 reduction is this product's own unit-economics
// SLO (docs/architecture/overview.md), not an aspiration.
//
// TG3 ("nothing is hidden — dismissed signals are retained and
// surfaced") is why signals_in is a count of EVERY case_signals row
// for the day, with no suppression-status filter of any kind: P2-10
// already made suppressed signals "still stored and counted, just not
// escalated", and this ticket's own job is to measure the real funnel
// honestly, not to quietly exclude a category of signal from the
// denominator to make the ratio look better than it is. See store.go's
// own query for where this is actually enforced (by omission — there
// is simply no WHERE clause narrowing which signals count).
package reduction

// Ratio computes the signal-to-case reduction ratio for one tenant's
// day. ok is false when signals is 0 — T3's own "a tenant with zero
// signals produces no division error and no spurious alert": a quiet
// tenant is not a DEGRADED tenant, and the caller (store.go's
// ComputeDaily, cmd/correlate's own gauge export) must skip recording
// anything for this day rather than reporting a ratio of 0, which
// would otherwise look identical to a genuine, alertable collapse.
func Ratio(signals, casesEscalated uint64) (ratio float64, ok bool) {
	if signals == 0 {
		return 0, false
	}
	return float64(signals) / float64(casesEscalated), true
}
