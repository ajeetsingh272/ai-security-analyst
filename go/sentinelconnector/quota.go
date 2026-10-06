package sentinelconnector

// Quota is one tenant's token-bucket shape: EPS is the steady refill rate,
// Burst is the bucket's capacity — how far a quiet tenant can burst above
// EPS before the limiter starts throttling, built up from unused capacity
// during quiet periods.
type Quota struct {
	EPS   int
	Burst int
}

// DefaultQuotas maps the tenants.plan column's values (db/postgres/migrations
// /0001_foundation.sql's tenants_plan_check) to a starting quota. These
// numbers are a reasonable starting point, not a researched pricing
// decision — nothing in this codebase documents per-tier EPS targets yet.
// What AC1 actually asks for is the MECHANISM (configurable, tiered
// defaults); retuning these later is a one-line change, not a redesign.
var DefaultQuotas = map[string]Quota{
	"trial":          {EPS: 50, Burst: 100},
	"small_business": {EPS: 200, Burst: 400},
	"startup":        {EPS: 500, Burst: 1000},
	"msp":            {EPS: 2000, Burst: 4000},
}

// FallbackQuota is the conservative GLOBAL limit AC5 asks for when Redis is
// unavailable — applied per-tenant still (FailOpenLimiter keys its
// in-memory buckets by tenant, same as the Redis path), but deliberately
// at the trial tier's level regardless of a tenant's real plan: with no
// Redis to persist real usage, the safe default is the smallest quota any
// tenant could legitimately have, not an attempt to guess their actual one.
var FallbackQuota = DefaultQuotas["trial"]
