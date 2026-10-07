package sentinelenrich

import "testing"

const fixtureTor = "1.2.3.4\n# a comment\n\n5.6.7.8\n"

const fixtureVPN = "10.0.0.0/24\n# comment\n198.51.100.0/24\n"

const fixtureDatacenter = "203.0.113.0/24\n"

const fixtureCountry = "1.2.3.0,1.2.3.255,US\n8.8.8.0,8.8.8.255,US\n9.9.9.0,9.9.9.255,CA\n"

const fixtureASN = `1.2.3.0,1.2.3.255,13335,"Cloudflare, Inc."
8.8.8.0,8.8.8.255,15169,Google LLC
`

func testFeeds() Feeds {
	return Feeds{
		TorExitList:    []byte(fixtureTor),
		VPNList:        []byte(fixtureVPN),
		DatacenterList: []byte(fixtureDatacenter),
		CountryCSV:     []byte(fixtureCountry),
		ASNCSV:         []byte(fixtureASN),
	}
}

func TestNewStore_ParsesAllFeedsWithoutError(t *testing.T) {
	_, errs := NewStore(testFeeds())
	if len(errs) != 0 {
		t.Fatalf("NewStore: %v", errs)
	}
}

// T1: a known Tor exit node is classified as an anonymiser.
func TestLookup_TorExitIsAnonymiser(t *testing.T) {
	s, _ := NewStore(testFeeds())
	c := s.Lookup("1.2.3.4")
	if !c.IsTorExit {
		t.Error("IsTorExit = false, want true")
	}
	if !c.Anonymiser() {
		t.Error("Anonymiser() = false, want true")
	}
	if len(c.Provenance) == 0 {
		t.Error("Provenance is empty, want the tor feed named (AC5)")
	}
}

func TestLookup_VPNRangeIsAnonymiser(t *testing.T) {
	s, _ := NewStore(testFeeds())
	c := s.Lookup("10.0.0.42")
	if !c.IsVPN {
		t.Error("IsVPN = false, want true")
	}
	if !c.Anonymiser() {
		t.Error("Anonymiser() = false, want true (VPN counts)")
	}
}

func TestLookup_DatacenterRangeIsHostingNotAnonymiser(t *testing.T) {
	s, _ := NewStore(testFeeds())
	c := s.Lookup("203.0.113.77")
	if !c.IsHosting {
		t.Error("IsHosting = false, want true")
	}
	if c.Anonymiser() {
		t.Error("Anonymiser() = true, want false — hosting alone is not an anonymiser")
	}
}

// T2: geolocation enrichment is correct for a known address set.
func TestLookup_GeolocationAndASN(t *testing.T) {
	s, _ := NewStore(testFeeds())
	c := s.Lookup("8.8.8.8")
	if c.Country != "US" {
		t.Errorf("Country = %q, want US", c.Country)
	}
	if c.ASN != 15169 || c.ASName != "Google LLC" {
		t.Errorf("ASN/ASName = %d/%q, want 15169/Google LLC", c.ASN, c.ASName)
	}

	c2 := s.Lookup("9.9.9.9")
	if c2.Country != "CA" {
		t.Errorf("Country = %q, want CA", c2.Country)
	}
}

// Confirms encoding/csv, not a naive split, handles an AS name
// containing a comma inside quotes (geolite2-asn's own real-world
// shape — "Cloudflare, Inc." is a real AS name, not a fixture
// contrivance).
func TestLookup_ASNameWithEmbeddedComma(t *testing.T) {
	s, _ := NewStore(testFeeds())
	c := s.Lookup("1.2.3.1")
	if c.ASName != "Cloudflare, Inc." {
		t.Errorf("ASName = %q, want %q", c.ASName, "Cloudflare, Inc.")
	}
}

func TestLookup_UnknownAddressIsAllZeroValue(t *testing.T) {
	s, _ := NewStore(testFeeds())
	c := s.Lookup("172.16.5.5")
	if c.IsTorExit || c.IsVPN || c.IsHosting || c.Country != "" || c.ASN != 0 {
		t.Errorf("expected an all-zero Classification for an unrecognised address, got %+v", c)
	}
	if len(c.Provenance) != 0 {
		t.Errorf("Provenance = %v, want empty", c.Provenance)
	}
}

func TestLookup_InvalidIPIsHandledSafely(t *testing.T) {
	s, _ := NewStore(testFeeds())
	c := s.Lookup("not-an-ip")
	if c.IsTorExit || c.IsVPN || c.Country != "" {
		t.Errorf("expected a zero-value Classification for an invalid IP, got %+v", c)
	}
}

func TestLookup_NilStoreIsSafe(t *testing.T) {
	var s *Store
	c := s.Lookup("8.8.8.8")
	if c.IP != "8.8.8.8" || c.IsTorExit || c.Country != "" {
		t.Errorf("expected a safe zero-value Classification from a nil Store, got %+v", c)
	}
}

// AC4's own "one feed's failure doesn't take the others down": a
// malformed country feed must not prevent the ASN/VPN/Tor feeds from
// loading and answering correctly.
func TestNewStore_OneBadFeedDoesNotBreakTheOthers(t *testing.T) {
	feeds := testFeeds()
	feeds.CountryCSV = []byte("this is not,a,valid\nCSV\x00row\n")
	s, _ := NewStore(feeds)
	c := s.Lookup("1.2.3.4")
	if !c.IsTorExit {
		t.Error("IsTorExit = false, want true — an unrelated feed's own parse issue must not affect this one")
	}
}
