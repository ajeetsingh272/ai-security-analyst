package sentinelenrich

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type fakeFetcher struct {
	feeds Feeds
	err   error
	calls int
}

func (f *fakeFetcher) Fetch(context.Context) (Feeds, error) {
	f.calls++
	if f.err != nil {
		return Feeds{}, f.err
	}
	return f.feeds, nil
}

func newTestRefresher(t *testing.T, fetcher Fetcher) *Refresher {
	t.Helper()
	dir := t.TempDir()
	return New(Options{CacheDir: dir, Fetcher: fetcher, Interval: time.Hour, StaleThreshold: 2 * time.Hour})
}

func TestRefresher_LookupBeforeAnyRefreshIsSafeAndEmpty(t *testing.T) {
	r := newTestRefresher(t, &fakeFetcher{feeds: testFeeds()})
	c := r.Lookup("1.2.3.4")
	if c.IsTorExit {
		t.Error("expected no classification before any refresh has run")
	}
	if !r.IsStale() {
		t.Error("IsStale() = false before any successful refresh, want true")
	}
}

func TestRefresher_RefreshOnceLoadsFeedsAndClearsStale(t *testing.T) {
	r := newTestRefresher(t, &fakeFetcher{feeds: testFeeds()})
	r.refreshOnce(context.Background())

	c := r.Lookup("1.2.3.4")
	if !c.IsTorExit {
		t.Error("expected the Tor fixture address to classify correctly after a refresh")
	}
	if r.IsStale() {
		t.Error("IsStale() = true immediately after a successful refresh, want false")
	}
}

// AC4: a stale feed degrades gracefully — a failed fetch must not
// discard the previously loaded, still-good data.
func TestRefresher_FailedFetchKeepsPreviousStore(t *testing.T) {
	fetcher := &fakeFetcher{feeds: testFeeds()}
	r := newTestRefresher(t, fetcher)
	r.refreshOnce(context.Background())

	fetcher.err = fmt.Errorf("feed provider outage")
	fetcher.feeds = Feeds{} // if this somehow got used, Lookup would stop finding anything
	r.refreshOnce(context.Background())

	c := r.Lookup("1.2.3.4")
	if !c.IsTorExit {
		t.Error("a failed refresh discarded the previously good data — AC4 requires graceful degradation")
	}
}

// T4: a stale feed beyond its threshold raises an alert — proven here
// as "IsStale() becomes true", the condition a caller (or this
// package's own Stale gauge) alerts on.
func TestRefresher_StaleAfterThresholdWithNoSuccessfulRefresh(t *testing.T) {
	r := newTestRefresher(t, &fakeFetcher{err: fmt.Errorf("down")})
	r.refreshOnce(context.Background())
	if !r.IsStale() {
		t.Error("IsStale() = false after every refresh attempt has failed, want true")
	}

	// Simulate time having passed since a real success by backdating
	// lastSuccess directly rather than sleeping past StaleThreshold in a
	// test.
	r2 := newTestRefresher(t, &fakeFetcher{feeds: testFeeds()})
	r2.refreshOnce(context.Background())
	r2.lastSuccess.Store(time.Now().Add(-3 * time.Hour).Unix())
	if !r2.IsStale() {
		t.Error("IsStale() = false long after the last success, want true")
	}
}

func TestRefresher_CacheRoundTrip(t *testing.T) {
	dir := t.TempDir()
	fetcher := &fakeFetcher{feeds: testFeeds()}
	r := New(Options{CacheDir: dir, Fetcher: fetcher, Interval: time.Hour})
	r.refreshOnce(context.Background())

	for _, name := range cacheFileNames {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("expected cache file %s to exist: %v", name, err)
		}
	}

	// A fresh Refresher (simulating a new process) loads the cache
	// written by the one above and can answer Lookup correctly before
	// ever calling Fetch.
	fresh := New(Options{CacheDir: dir, Fetcher: &fakeFetcher{err: fmt.Errorf("network unavailable")}})
	if err := fresh.LoadFromCache(); err != nil {
		t.Fatalf("LoadFromCache: %v", err)
	}
	c := fresh.Lookup("1.2.3.4")
	if !c.IsTorExit {
		t.Error("expected LoadFromCache to make the cached data queryable immediately")
	}
}

func TestRefresher_LoadFromCacheWithNoCacheIsAnError(t *testing.T) {
	r := New(Options{CacheDir: t.TempDir()})
	if err := r.LoadFromCache(); err == nil {
		t.Fatal("expected an error loading from an empty cache directory")
	}
}

func TestRefresher_PanicInFetcherIsRecovered(t *testing.T) {
	r := newTestRefresher(t, panicFetcher{})
	r.refreshOnce(context.Background()) // must not propagate the panic
	if !r.IsStale() {
		t.Error("expected IsStale() = true after a panicking refresh attempt")
	}
}

type panicFetcher struct{}

func (panicFetcher) Fetch(context.Context) (Feeds, error) {
	panic("boom")
}
