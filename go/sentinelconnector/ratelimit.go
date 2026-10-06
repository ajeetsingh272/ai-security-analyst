package sentinelconnector

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// RateLimiter gates how many of n requested events a tenant may publish
// right now, returning a PARTIAL grant rather than a yes/no — the overflow
// (n - granted) is what AC3's "overflow spills to archive for later
// replay instead of being dropped" is about: the scheduler publishes
// `granted` normally and archives the rest, never drops it.
type RateLimiter interface {
	Allow(ctx context.Context, tenantID string, quota Quota, n int) (granted int, err error)
}

// tokenBucketScript is a single atomic Redis operation — refill-then-take
// — so two concurrent requests for the same tenant can never both read the
// same token count and over-grant. KEYS[1] is the bucket's hash key;
// ARGV: capacity, refill-per-second, now (unix millis), requested tokens.
// Returns the integer number of tokens actually granted.
//
// Token count is kept as a float internally (fractional refill between
// calls happening less than a second apart is real and should accumulate,
// not be truncated away every call — truncating every call would make a
// tenant well under quota still get throttled at sub-second granularity)
// but only a whole number of tokens is ever GRANTED, since "0.6 of an
// event" is not a thing a caller can publish.
const tokenBucketScript = `
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'last_refill_ms')
local tokens = tonumber(bucket[1])
local last_refill_ms = tonumber(bucket[2])

local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

if tokens == nil then
  tokens = capacity
  last_refill_ms = now_ms
end

local elapsed_sec = math.max(0, now_ms - last_refill_ms) / 1000.0
tokens = math.min(capacity, tokens + elapsed_sec * refill_per_sec)

local granted = math.floor(math.min(tokens, requested))
tokens = tokens - granted

redis.call('HMSET', KEYS[1], 'tokens', tokens, 'last_refill_ms', now_ms)
-- An inactive tenant's bucket is worthless to keep forever; one hour of no
-- traffic is long enough that losing partial accumulated burst capacity is
-- not a correctness problem, only a minor convenience one.
redis.call('EXPIRE', KEYS[1], 3600)

return granted
`

// RedisTokenBucket is the real implementation — AC1/AC2's actual
// enforcement, token-bucket rather than fixed-window specifically because
// T2 requires "refills at the configured rate" (continuous, not an
// all-at-once reset the way apps/api's sign-in rate limiter works — that
// one is fixed-window on purpose for a different reason, see its own doc
// comment; a token bucket is the right shape here because ingest traffic
// is continuous, not "N attempts then blocked for a cooldown").
type RedisTokenBucket struct {
	client *redis.Client
	script *redis.Script
}

func NewRedisTokenBucket(client *redis.Client) *RedisTokenBucket {
	return &RedisTokenBucket{client: client, script: redis.NewScript(tokenBucketScript)}
}

func (r *RedisTokenBucket) Allow(ctx context.Context, tenantID string, quota Quota, n int) (int, error) {
	key := "ratelimit:ingest:" + tenantID
	nowMs := time.Now().UnixMilli()
	result, err := r.script.Run(ctx, r.client, []string{key}, quota.Burst, quota.EPS, nowMs, n).Result()
	if err != nil {
		return 0, fmt.Errorf("sentinelconnector: token bucket script: %w", err)
	}
	granted, ok := result.(int64)
	if !ok {
		return 0, fmt.Errorf("sentinelconnector: token bucket script returned %T, want int64", result)
	}
	return int(granted), nil
}

// FailOpenLimiter wraps a RateLimiter (the real Redis-backed one) and
// degrades to an in-process, per-tenant token bucket at FallbackQuota
// whenever the wrapped limiter errors — AC5, "Redis unavailability fails
// open with a conservative global limit rather than halting ingest".
// "Fails open" here means ingest CONTINUES, at a conservative rate, not
// that it bypasses limiting entirely — an unlimited fail-open would let
// exactly the noisy-neighbour scenario this whole ticket exists to prevent
// happen precisely when the safety net (Redis) is down.
type FailOpenLimiter struct {
	primary    RateLimiter
	fallback   *InMemoryTokenBucket
	onFailOpen func(tenantID string, err error)
}

func NewFailOpenLimiter(primary RateLimiter, onFailOpen func(tenantID string, err error)) *FailOpenLimiter {
	return &FailOpenLimiter{primary: primary, fallback: NewInMemoryTokenBucket(), onFailOpen: onFailOpen}
}

func (f *FailOpenLimiter) Allow(ctx context.Context, tenantID string, quota Quota, n int) (int, error) {
	granted, err := f.primary.Allow(ctx, tenantID, quota, n)
	if err == nil {
		return granted, nil
	}
	if f.onFailOpen != nil {
		f.onFailOpen(tenantID, err)
	}
	// FallbackQuota, not the tenant's real quota — see FallbackQuota's own
	// doc comment for why a degraded Redis is not the moment to trust
	// whatever quota value the caller happened to pass in.
	return f.fallback.Allow(ctx, tenantID, FallbackQuota, n)
}

// InMemoryTokenBucket is the degraded-mode implementation FailOpenLimiter
// falls back to — same token-bucket algorithm as the Lua script, just
// process-local instead of shared across however many scheduler instances
// might be running. That's the actual, honest cost of Redis being down:
// each process enforces its own conservative limit independently rather
// than one shared one, not a reason to stop ingesting altogether.
type InMemoryTokenBucket struct {
	mu      sync.Mutex
	buckets map[string]*bucketState
}

type bucketState struct {
	tokens       float64
	lastRefillMs int64
}

func NewInMemoryTokenBucket() *InMemoryTokenBucket {
	return &InMemoryTokenBucket{buckets: make(map[string]*bucketState)}
}

func (b *InMemoryTokenBucket) Allow(_ context.Context, tenantID string, quota Quota, n int) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	nowMs := time.Now().UnixMilli()
	s, ok := b.buckets[tenantID]
	if !ok {
		s = &bucketState{tokens: float64(quota.Burst), lastRefillMs: nowMs}
		b.buckets[tenantID] = s
	}

	elapsedSec := float64(nowMs-s.lastRefillMs) / 1000.0
	if elapsedSec < 0 {
		elapsedSec = 0
	}
	s.tokens = minFloat(float64(quota.Burst), s.tokens+elapsedSec*float64(quota.EPS))
	s.lastRefillMs = nowMs

	granted := int(minFloat(s.tokens, float64(n)))
	s.tokens -= float64(granted)
	return granted, nil
}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
