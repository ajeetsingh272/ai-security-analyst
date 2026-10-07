//go:build integration

package sentinelenrich

import (
	"context"
	"strings"
	"testing"
	"time"
)

// T3: a feed provider outage does not stall detection. Proven two ways
// in one test: first, that the REAL feeds (not fixtures) fetch and
// parse into a usable Store at all; second, that once loaded, Lookup
// itself is effectively instantaneous regardless of feed size — the
// property that actually matters for "detection never blocks", since a
// provider being down or slow only ever affects the background
// Refresher.refreshOnce call, never a Lookup.
func TestHTTPFetcher_RealFeedsLoadAndLookupIsFast(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	fetcher := NewHTTPFetcher()
	feeds, err := fetcher.Fetch(ctx)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}

	store, errs := NewStore(feeds)
	if len(errs) != 0 {
		t.Fatalf("NewStore: %v", errs)
	}

	// A real, well-known address should resolve to a real ASN —
	// 1.1.1.1 is Cloudflare's own public resolver, ASN 13335. Country
	// is deliberately NOT asserted for this address: 1.1.1.1 is
	// anycast, announced from many countries simultaneously, and
	// GeoLite2's own data has no single country entry for it at all —
	// found the hard way, by this test originally asserting one and
	// failing against the real feed. The country table itself is
	// checked separately below, against a range that does carry one.
	c := store.Lookup("1.1.1.1")
	if c.ASN != 13335 {
		t.Errorf("1.1.1.1 ASN = %d, want 13335 (Cloudflare)", c.ASN)
	}
	if len(store.country) == 0 {
		t.Error("the real country feed loaded zero ranges")
	}
	// T2: pick a real range's own midpoint from the live feed and
	// confirm Lookup resolves it to that exact range's own country —
	// proof the parsing and the range search agree with the feed's own
	// data, not just that SOME country string came back from somewhere.
	mid := store.country[len(store.country)/2]
	midIP := uint32ToIPv4(mid.Start)
	if c := store.Lookup(midIP); c.Country != mid.Value {
		t.Errorf("Lookup(%s) Country = %q, want %q (the real feed's own range)", midIP, c.Country, mid.Value)
	}

	// The real Tor exit list is non-empty and every address in it
	// classifies as an exit — take the first real one from the feed
	// itself rather than hard-coding an IP that will eventually rotate
	// out of the list.
	first := firstNonEmptyLine(feeds.TorExitList)
	if first == "" {
		t.Fatal("the real Tor exit list fetch returned no usable address")
	}
	if c := store.Lookup(first); !c.IsTorExit {
		t.Errorf("expected %s (from the real exit list) to classify as a Tor exit", first)
	}

	// The actual property T3 cares about: Lookup itself never touches
	// the network, so it is fast regardless of how large the feeds are
	// or how slow the provider was to serve them.
	start := time.Now()
	for i := 0; i < 1000; i++ {
		store.Lookup("1.1.1.1")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("1000 Lookup calls took %v, want well under 1s — Lookup must never block on the network", elapsed)
	}
}

func firstNonEmptyLine(data []byte) string {
	start := 0
	for i, b := range data {
		if b == '\n' {
			line := strings.TrimRight(string(data[start:i]), "\r")
			if line != "" && line[0] != '#' {
				return line
			}
			start = i + 1
		}
	}
	return ""
}
