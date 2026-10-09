package google

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// Mirrors m365/content_test.go's own TestManagementAPI_HonoursRetryAfter_WithoutHotRetrying
// — the injected sleep function (not a real time.Sleep) proves the backoff
// duration without the test actually waiting for it.
func TestReportsAPI_HonoursRetryAfter_WithoutHotRetrying(t *testing.T) {
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
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	defer srv.Close()

	var sleptFor time.Duration
	var sleepCalls int
	api := newReportsAPI(http.DefaultClient, srv.URL)
	api.sleep = func(_ context.Context, d time.Duration) error {
		sleptFor = d
		sleepCalls++
		return nil // deliberately does NOT actually sleep
	}

	start := time.Now()
	items, err := api.listActivities(context.Background(), "token", "login", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z")
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("listActivities: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("expected an empty activity list, got %d items", len(items))
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
		t.Fatalf("test took %v — the fake sleep should have made this near-instant", elapsed)
	}
}

// A quota-exceeded 403 (Google's OTHER throttling signal, distinct from a
// plain 429 — see content.go's own isThrottled) is recognised and backed
// off the same way, with no Retry-After header at all (Google does not
// always set one, unlike Microsoft's own API).
func TestReportsAPI_QuotaExceeded403_StillBacksOff(t *testing.T) {
	var requestCount int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&requestCount, 1) == 1 {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":{"code":403,"errors":[{"reason":"rateLimitExceeded"}]}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	defer srv.Close()

	var sleptFor time.Duration
	api := newReportsAPI(http.DefaultClient, srv.URL)
	api.sleep = func(_ context.Context, d time.Duration) error {
		sleptFor = d
		return nil
	}

	_, err := api.listActivities(context.Background(), "token", "login", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z")
	if err != nil {
		t.Fatalf("listActivities: %v", err)
	}
	if sleptFor <= 0 {
		t.Fatalf("expected a positive fallback backoff for a quota-exceeded 403, got %v", sleptFor)
	}
}

// An ordinary 403 (e.g. a genuine permissions problem, not a quota signal)
// must NOT be treated as throttling — it should surface immediately as an
// error, not loop through retries that can never succeed.
func TestReportsAPI_OrdinaryForbidden_IsNotTreatedAsThrottle(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":403,"errors":[{"reason":"insufficientPermissions"}]}}`))
	}))
	defer srv.Close()

	sleepCalls := 0
	api := newReportsAPI(http.DefaultClient, srv.URL)
	api.sleep = func(_ context.Context, d time.Duration) error {
		sleepCalls++
		return nil
	}

	_, err := api.listActivities(context.Background(), "token", "login", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z")
	if err == nil {
		t.Fatal("expected an error for a genuine permissions 403")
	}
	if sleepCalls != 0 {
		t.Fatalf("expected no backoff sleep for a non-throttling 403, got %d", sleepCalls)
	}
}

// Giving up after maxThrottleRetries consecutive throttle responses rather
// than retrying forever.
func TestReportsAPI_GivesUpAfterMaxThrottleRetries(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	sleepCalls := 0
	api := newReportsAPI(http.DefaultClient, srv.URL)
	api.sleep = func(_ context.Context, d time.Duration) error {
		sleepCalls++
		return nil
	}

	_, err := api.listActivities(context.Background(), "token", "login", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z")
	if err == nil {
		t.Fatal("expected an error after exhausting throttle retries, got nil")
	}
	if sleepCalls != maxThrottleRetries {
		t.Fatalf("expected %d backoff sleeps before giving up, got %d", maxThrottleRetries, sleepCalls)
	}
}

// Pagination: listActivities must follow every nextPageToken the Reports
// API returns, mirroring m365's own NextPageUri-following test.
func TestReportsAPI_FollowsNextPageTokenAcrossMultiplePages(t *testing.T) {
	var requestCount int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&requestCount, 1)
		w.Header().Set("Content-Type", "application/json")
		if n == 1 {
			_, _ = w.Write([]byte(`{"items":[{"id":{"uniqueQualifier":"a","time":"2024-01-01T00:00:00.000Z","applicationName":"login"}}],"nextPageToken":"page-2"}`))
			return
		}
		_, _ = w.Write([]byte(`{"items":[{"id":{"uniqueQualifier":"b","time":"2024-01-01T00:01:00.000Z","applicationName":"login"}}]}`))
	}))
	defer srv.Close()

	api := newReportsAPI(http.DefaultClient, srv.URL)
	items, err := api.listActivities(context.Background(), "token", "login", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z")
	if err != nil {
		t.Fatalf("listActivities: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items across 2 pages, got %d", len(items))
	}
	if requestCount != 2 {
		t.Fatalf("expected exactly 2 requests (page 1 + page 2), got %d", requestCount)
	}
}
