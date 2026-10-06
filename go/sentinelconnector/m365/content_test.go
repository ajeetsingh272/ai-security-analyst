package m365

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// T3: "429 with Retry-After is respected rather than hot-retried." Proven
// two ways at once: the request is actually retried (so throttling doesn't
// just fail outright), AND the injected sleep function — not a real
// time.Sleep — is called with exactly the duration the server's
// Retry-After header specified, so this test runs in milliseconds despite
// asserting a 30-second backoff was "honoured."
func TestManagementAPI_HonoursRetryAfter_WithoutHotRetrying(t *testing.T) {
	var requestCount int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&requestCount, 1)
		if n == 1 {
			w.Header().Set("Retry-After", "30")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	var sleptFor time.Duration
	var sleepCalls int
	api := newManagementAPI(http.DefaultClient, srv.URL)
	api.sleep = func(_ context.Context, d time.Duration) error {
		sleptFor = d
		sleepCalls++
		return nil // deliberately does NOT actually sleep — that's the whole point
	}

	start := time.Now()
	items, err := api.listAvailableContent(context.Background(), "token", "tenant-guid", "Audit.Exchange", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z")
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("listAvailableContent: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("expected an empty content list, got %d items", len(items))
	}
	if requestCount != 2 {
		t.Fatalf("expected exactly 2 requests (one throttled, one success), got %d", requestCount)
	}
	if sleepCalls != 1 {
		t.Fatalf("expected exactly 1 backoff sleep, got %d", sleepCalls)
	}
	if sleptFor != 30*time.Second {
		t.Fatalf("expected the backoff to respect Retry-After: 30, got %v", sleptFor)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("test took %v — the fake sleep should have made this near-instant, not a hot retry loop either", elapsed)
	}
}

// A 429 with no Retry-After header at all (or a malformed one) still backs
// off, using a conservative fallback rather than treating "header missing"
// as "retry immediately" — the exact failure mode T3 exists to rule out.
func TestManagementAPI_MissingRetryAfterStillBacksOff(t *testing.T) {
	var requestCount int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&requestCount, 1) == 1 {
			w.WriteHeader(http.StatusTooManyRequests) // no Retry-After header
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	var sleptFor time.Duration
	api := newManagementAPI(http.DefaultClient, srv.URL)
	api.sleep = func(_ context.Context, d time.Duration) error {
		sleptFor = d
		return nil
	}

	_, err := api.listAvailableContent(context.Background(), "token", "tenant-guid", "Audit.Exchange", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z")
	if err != nil {
		t.Fatalf("listAvailableContent: %v", err)
	}
	if sleptFor <= 0 {
		t.Fatalf("expected a positive fallback backoff, got %v", sleptFor)
	}
}

// Giving up after maxThrottleRetries consecutive 429s, rather than retrying
// forever — a persistently throttled connector must surface as a failed
// cycle (so the scheduler's next tick retries, and health degrades) rather
// than blocking this cycle indefinitely.
func TestManagementAPI_GivesUpAfterMaxThrottleRetries(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	sleepCalls := 0
	api := newManagementAPI(http.DefaultClient, srv.URL)
	api.sleep = func(_ context.Context, d time.Duration) error {
		sleepCalls++
		return nil
	}

	_, err := api.listAvailableContent(context.Background(), "token", "tenant-guid", "Audit.Exchange", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z")
	if err == nil {
		t.Fatal("expected an error after exhausting throttle retries, got nil")
	}
	if sleepCalls != maxThrottleRetries {
		t.Fatalf("expected %d backoff sleeps before giving up, got %d", maxThrottleRetries, sleepCalls)
	}
}
