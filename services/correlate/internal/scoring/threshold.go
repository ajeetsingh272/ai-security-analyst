package scoring

// PlanTier mirrors tenants.plan (db/postgres/migrations/0001_foundation.sql).
type PlanTier string

const (
	PlanTrial      PlanTier = "trial"
	PlanPro        PlanTier = "pro"
	PlanEnterprise PlanTier = "enterprise"
)

// defaultThreshold is used for any plan tier not named below — a
// typo'd or future tier degrades to the most conservative (highest)
// threshold rather than silently escalating everything.
const defaultThreshold = 40.0

// escalationThreshold is AC3's own "configurable per tenant plan
// tier" — a plain Go map, not a DB-backed setting: nothing yet exposes
// a UI or API to override it per tenant, so there is no state to
// persist beyond this fixed, reviewable table. A tenant-level override
// is real, separate future work if a customer ever needs one.
var escalationThreshold = map[PlanTier]float64{
	// Enterprise tenants pay for (and expect) more triage attention per
	// case, so the bar to escalate is lower — more cases reach a human
	// or the LLM, not fewer.
	PlanEnterprise: 25,
	PlanPro:        32,
	PlanTrial:      40,
}

// EscalationThreshold returns the score a case must reach or exceed to
// be escalated past automatic triage, for the given tenant plan tier.
func EscalationThreshold(plan PlanTier) float64 {
	if t, ok := escalationThreshold[plan]; ok {
		return t
	}
	return defaultThreshold
}

// IsEscalated reports whether score meets or exceeds plan's own
// escalation threshold.
func IsEscalated(score float64, plan PlanTier) bool {
	return score >= EscalationThreshold(plan)
}
