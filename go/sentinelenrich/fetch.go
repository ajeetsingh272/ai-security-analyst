package sentinelenrich

import (
	"context"
	"fmt"
	"io"
	"net/http"
)

// Feed source URLs — pinned to specific, stable, no-API-key-required
// public endpoints, the same "a dependency's exact version is a
// deliberate, reviewed choice" discipline this repo already applies to
// the Sigma spec (sigmac.SpecVersion) and the ATT&CK catalogue
// (attck.CatalogueVersion). Unlike those two, these feeds are meant to
// change often (that is the whole point of refreshing them), so what is
// pinned here is the SOURCE, not a snapshot of its content.
const (
	// TorExitListURL is the Tor Project's own bulk exit list — exact
	// IPv4 addresses, one per line, maintained specifically for this
	// "is this address a Tor exit" use case.
	TorExitListURL = "https://check.torproject.org/torbulkexitlist"
	// VPNListURL/DatacenterListURL are X4BNet's own maintained,
	// no-key-required CIDR lists (github.com/X4BNet/lists_vpn).
	VPNListURL        = "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt"
	DatacenterListURL = "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt"
	// CountryCSVURL/ASNCSVURL are sapics/ip-location-db's own
	// GeoLite2-derived, freely redistributable CSV exports — no API key,
	// updated regularly from MaxMind's GeoLite2 feed under its EULA
	// (github.com/sapics/ip-location-db — see that repo's own
	// GEOLITE2_LICENSE for terms).
	CountryCSVURL = "https://raw.githubusercontent.com/sapics/ip-location-db/main/geolite2-country/geolite2-country-ipv4.csv"
	ASNCSVURL     = "https://raw.githubusercontent.com/sapics/ip-location-db/main/geolite2-asn/geolite2-asn-ipv4.csv"
)

// Fetcher retrieves one fresh copy of every feed. A real implementation
// (HTTPFetcher) makes network calls; Refresher is the only caller, and
// only from its own background ticker — nothing on a Lookup's own call
// path ever invokes a Fetcher, which is what keeps AC1 ("detection never
// makes a synchronous external call") true regardless of how this
// interface is implemented.
type Fetcher interface {
	Fetch(ctx context.Context) (Feeds, error)
}

// HTTPFetcher is the real Fetcher — one GET per feed URL. All five must
// succeed for Fetch to return a usable Feeds; Refresher's own "keep the
// old Store on any failure" policy (not a partial per-feed merge) is
// what actually implements AC4's graceful degradation, so this type
// stays simple: fetch everything, or report what failed.
type HTTPFetcher struct {
	Client *http.Client
}

func NewHTTPFetcher() *HTTPFetcher {
	return &HTTPFetcher{Client: http.DefaultClient}
}

func (f *HTTPFetcher) Fetch(ctx context.Context) (Feeds, error) {
	client := f.Client
	if client == nil {
		client = http.DefaultClient
	}

	var feeds Feeds
	type fetchTarget struct {
		url  string
		dest *[]byte
	}
	fetches := []fetchTarget{
		{TorExitListURL, &feeds.TorExitList},
		{VPNListURL, &feeds.VPNList},
		{DatacenterListURL, &feeds.DatacenterList},
		{CountryCSVURL, &feeds.CountryCSV},
		{ASNCSVURL, &feeds.ASNCSV},
	}

	for _, fe := range fetches {
		body, err := fetchOne(ctx, client, fe.url)
		if err != nil {
			return Feeds{}, fmt.Errorf("fetching %s: %w", fe.url, err)
		}
		*fe.dest = body
	}
	return feeds, nil
}

func fetchOne(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}
