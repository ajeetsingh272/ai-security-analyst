package sentinelenrich

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel/metric"
)

// cacheFileNames maps each Feeds field to its on-disk cache file —
// AC1's own "cached locally": a fresh process loads whatever was cached
// from its last successful refresh before making its own first fetch,
// so Lookup answers correctly (from the last known-good data) even
// before this process has itself reached the network once.
var cacheFileNames = map[string]string{
	"tor":        "tor-exit-list.txt",
	"vpn":        "vpn.txt",
	"datacenter": "datacenter.txt",
	"country":    "country.csv",
	"asn":        "asn.csv",
}

// Metrics are optional (nil-safe) — the same pattern every other
// optional capability in this repo already uses.
type Metrics struct {
	RefreshErrors metric.Int64Counter
	// Stale is 1 when IsStale() is currently true, 0 otherwise — a
	// gauge rather than a counter, since what an operator needs to
	// alert on (AC4) is the CURRENT state, not a cumulative count of
	// how many times it has ever gone stale.
	Stale metric.Int64Gauge
}

// Options configures a Refresher. All fields have workable defaults —
// only CacheDir is required, since it is the one thing this package
// cannot reasonably default (it must be a real, writable directory the
// caller chose).
type Options struct {
	CacheDir string
	Fetcher  Fetcher
	Log      *slog.Logger
	Metrics  Metrics
	// Interval is how often Refresher attempts a new fetch — AC1's own
	// "refreshed on a schedule". Defaults to 24h: these feeds (Tor
	// exits aside, which churn faster) do not meaningfully change
	// faster than daily, and refreshing ~35MB of data more often than
	// that would cost real bandwidth for no real freshness gain.
	Interval time.Duration
	// StaleThreshold is how long since the last SUCCESSFUL refresh
	// before IsStale reports true and the alert fires (AC4). Defaults
	// to 3x Interval — one or two missed cycles is noise; three in a
	// row is a real feed-provider outage worth paging on.
	StaleThreshold time.Duration
}

// Refresher owns one Store, replaced wholesale on every successful
// refresh and left untouched on every failed one — AC4's own "a stale
// feed degrades gracefully": Lookup always has SOME Store to query
// (even age-old data beats none), and a failed refresh is visible via
// IsStale/the Stale metric rather than silently discarding what still
// works.
type Refresher struct {
	cacheDir       string
	fetcher        Fetcher
	log            *slog.Logger
	metrics        Metrics
	interval       time.Duration
	staleThreshold time.Duration

	store       atomic.Pointer[Store]
	lastSuccess atomic.Int64 // unix seconds; 0 means "never"
}

func New(opts Options) *Refresher {
	log := opts.Log
	if log == nil {
		log = slog.Default()
	}
	fetcher := opts.Fetcher
	if fetcher == nil {
		fetcher = NewHTTPFetcher()
	}
	interval := opts.Interval
	if interval <= 0 {
		interval = 24 * time.Hour
	}
	staleThreshold := opts.StaleThreshold
	if staleThreshold <= 0 {
		staleThreshold = 3 * interval
	}
	r := &Refresher{
		cacheDir:       opts.CacheDir,
		fetcher:        fetcher,
		log:            log,
		metrics:        opts.Metrics,
		interval:       interval,
		staleThreshold: staleThreshold,
	}
	r.store.Store(&Store{}) // never nil — Lookup always has something to query, even before the first load.
	return r
}

// Lookup classifies ip against whichever Store is currently loaded.
// Never blocks on I/O — AC1's own property, made concrete: this is the
// one method the rest of the detection engine ever calls on its own
// per-event path.
func (r *Refresher) Lookup(ip string) Classification {
	return r.store.Load().Lookup(ip)
}

// IsStale reports whether the last successful refresh is older than
// StaleThreshold — AC4's own alert condition, exposed so a caller (the
// background loop below, or an operator's own dashboard query) can act
// on it without duplicating the threshold math.
func (r *Refresher) IsStale() bool {
	last := r.lastSuccess.Load()
	if last == 0 {
		return true
	}
	return time.Since(time.Unix(last, 0)) > r.staleThreshold
}

// LoadFromCache reads whatever was cached from this Refresher's own
// last successful refresh (possibly from a previous process) and, if
// present and parseable, makes it the current Store immediately — so a
// freshly started process can answer Lookup correctly before its own
// first scheduled refresh completes, or even before it has reached the
// network at all. Absence of a cache (first-ever start) is not an
// error: Lookup simply answers "not found" for everything until the
// first refresh lands, which Run kicks off right away.
func (r *Refresher) LoadFromCache() error {
	feeds, err := r.readCache()
	if err != nil {
		return err
	}
	store, errs := NewStore(feeds)
	for _, e := range errs {
		r.log.Error("parsing cached enrichment feed", "err", e)
	}
	r.store.Store(store)
	return nil
}

// Run blocks until ctx is cancelled, refreshing on Interval. The first
// refresh happens immediately (not after waiting a full Interval) so a
// fresh process reaches a fully warm Store as fast as the network
// allows, not a whole Interval later.
func (r *Refresher) Run(ctx context.Context) {
	r.refreshOnce(ctx)
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.refreshOnce(ctx)
		}
	}
}

func (r *Refresher) refreshOnce(ctx context.Context) {
	defer func() {
		if p := recover(); p != nil {
			r.log.Error("enrichment refresh panicked", "panic", p)
		}
	}()

	feeds, err := r.fetcher.Fetch(ctx)
	if err != nil {
		r.log.Error("fetching enrichment feeds failed, keeping previously loaded data", "err", err)
		if r.metrics.RefreshErrors != nil {
			r.metrics.RefreshErrors.Add(ctx, 1)
		}
		r.recordStaleness(ctx)
		return
	}

	store, parseErrs := NewStore(feeds)
	for _, e := range parseErrs {
		r.log.Error("parsing a fetched enrichment feed", "err", e)
	}

	r.store.Store(store)
	r.lastSuccess.Store(time.Now().Unix())
	if err := r.writeCache(feeds); err != nil {
		r.log.Error("writing enrichment feed cache", "err", err)
	}
	r.recordStaleness(ctx)
}

func (r *Refresher) recordStaleness(ctx context.Context) {
	if r.metrics.Stale == nil {
		return
	}
	v := int64(0)
	if r.IsStale() {
		v = 1
	}
	r.metrics.Stale.Record(ctx, v)
}

func (r *Refresher) readCache() (Feeds, error) {
	var feeds Feeds
	fields := map[string]*[]byte{
		"tor": &feeds.TorExitList, "vpn": &feeds.VPNList, "datacenter": &feeds.DatacenterList,
		"country": &feeds.CountryCSV, "asn": &feeds.ASNCSV,
	}
	for key, dest := range fields {
		data, err := os.ReadFile(filepath.Join(r.cacheDir, cacheFileNames[key]))
		if err != nil {
			return Feeds{}, err
		}
		*dest = data
	}
	return feeds, nil
}

// writeCache saves a freshly fetched Feeds to disk via a temp-file-then-
// rename per file — so a process crashing mid-write never leaves a
// truncated, unparseable cache file for the NEXT process's own
// LoadFromCache to trip over.
func (r *Refresher) writeCache(feeds Feeds) error {
	if r.cacheDir == "" {
		return nil
	}
	if err := os.MkdirAll(r.cacheDir, 0o755); err != nil {
		return err
	}
	fields := map[string][]byte{
		"tor": feeds.TorExitList, "vpn": feeds.VPNList, "datacenter": feeds.DatacenterList,
		"country": feeds.CountryCSV, "asn": feeds.ASNCSV,
	}
	for key, data := range fields {
		final := filepath.Join(r.cacheDir, cacheFileNames[key])
		tmp := final + ".tmp"
		if err := os.WriteFile(tmp, data, 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, final); err != nil {
			return err
		}
	}
	return nil
}
