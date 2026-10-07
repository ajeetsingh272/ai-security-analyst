package scoring

// PlanTier mirrors tenants.plan's own real CHECK constraint
// (db/postgres/migrations/0001_foundation.sql: 'msp', 'startup',
// 'small_business', 'trial'). P3-09's own real-Postgres replay
// harness is what actually caught this: an earlier version of this
// file invented fictional tier names ("pro", "enterprise") that never
// matched the real schema at all — inserting a real tenant with
// plan='enterprise' fails the DB's own CHECK constraint outright, and
// every real tenant's plan tier (other than 'trial', which happened
// to already match) would have silently fallen through to
// defaultThreshold below instead of its own configured value. Fixed
// here, at the one place this mapping is defined — no caller needed
// to change, since every call site already just passes through
// whatever string tenants.plan actually holds.
type PlanTier string

const (
	PlanTrial         PlanTier = "trial"
	PlanStartup       PlanTier = "startup"
	PlanSmallBusiness PlanTier = "small_business"
	PlanMSP           PlanTier = "msp"
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
	// An MSP manages many downstream client tenants through one
	// account, so the bar to escalate is lowest — more cases reach a
	// human or the LLM, not fewer, since noise there has the widest
	// blast radius.
	PlanMSP:           20,
	PlanSmallBusiness: 28,
	PlanStartup:       34,
	PlanTrial:         40,
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
