package sentinelenrich

import (
	"bytes"
	"net"
)

// Store is one fully-loaded, immutable snapshot of every feed — built
// once (NewStore), queried many times (Lookup), never mutated after
// construction. Refresher is what owns swapping one Store for a newer
// one as feeds refresh; Store itself has no notion of staleness or time
// at all.
//
// IPv4 only: every feed this package reads (the Tor Project's bulk exit
// list, X4BNet's VPN/datacenter lists, sapics/ip-location-db's
// GeoLite2-derived country/ASN tables) ships separate, much larger IPv6
// tables this package does not load — M365 sign-in ClientIP values seen
// in practice are overwhelmingly IPv4, and adding IPv6 support is a
// symmetric, independent extension of every parser/table here, not a
// design change, should a rule ever need it.
type Store struct {
	tor     map[string]bool
	vpn     rangeTable[struct{}]
	hosting rangeTable[struct{}]
	country rangeTable[string]
	asn     rangeTable[asnEntry]
}

// Feeds bundles one freshly-fetched copy of every feed's raw bytes —
// Refresher's own fetch step produces this; NewStore's only job is
// parsing it into a queryable Store. Separated so a unit test can build
// a Store from small in-memory fixtures without any HTTP involved at
// all.
type Feeds struct {
	TorExitList    []byte
	VPNList        []byte
	DatacenterList []byte
	CountryCSV     []byte
	ASNCSV         []byte
}

// NewStore parses Feeds into a queryable Store. A feed that fails to
// parse is reported but does not prevent the others from loading —
// AC4's "graceful degradation" applies at the level of one failed feed
// just as much as one entirely failed refresh cycle (Refresher's own
// job): a Tor-list outage should not also take geolocation down.
func NewStore(f Feeds) (*Store, []error) {
	var errs []error
	s := &Store{}

	if len(f.TorExitList) > 0 {
		tor, err := parseTorExitList(bytes.NewReader(f.TorExitList))
		if err != nil {
			errs = append(errs, err)
		} else {
			s.tor = tor
		}
	}
	if len(f.VPNList) > 0 {
		vpn, err := parseCIDRList(bytes.NewReader(f.VPNList))
		if err != nil {
			errs = append(errs, err)
		} else {
			s.vpn = vpn
		}
	}
	if len(f.DatacenterList) > 0 {
		hosting, err := parseCIDRList(bytes.NewReader(f.DatacenterList))
		if err != nil {
			errs = append(errs, err)
		} else {
			s.hosting = hosting
		}
	}
	if len(f.CountryCSV) > 0 {
		country, err := parseCountryCSV(bytes.NewReader(f.CountryCSV))
		if err != nil {
			errs = append(errs, err)
		} else {
			s.country = country
		}
	}
	if len(f.ASNCSV) > 0 {
		asn, err := parseASNCSV(bytes.NewReader(f.ASNCSV))
		if err != nil {
			errs = append(errs, err)
		} else {
			s.asn = asn
		}
	}
	return s, errs
}

// Lookup classifies one IP address against every feed currently loaded.
// Pure, in-memory, no I/O of any kind — this is AC1's own guarantee
// made concrete: whatever called Lookup never blocks on anything this
// function does.
func (s *Store) Lookup(ip string) Classification {
	c := Classification{IP: ip}
	if s == nil {
		return c
	}
	addr := net.ParseIP(ip)
	if addr == nil {
		return c
	}
	v4, ok := ipv4ToUint32(addr)
	if !ok {
		return c
	}

	if s.tor[ip] {
		c.IsTorExit = true
		c.Provenance = append(c.Provenance, "tor-bulk-exit-list")
	}
	if _, found := s.vpn.lookup(v4); found {
		c.IsVPN = true
		c.Provenance = append(c.Provenance, "x4bnet-vpn")
	}
	if _, found := s.hosting.lookup(v4); found {
		c.IsHosting = true
		c.Provenance = append(c.Provenance, "x4bnet-datacenter")
	}
	if country, found := s.country.lookup(v4); found {
		c.Country = country
		c.Provenance = append(c.Provenance, "geolite2-country")
	}
	if entry, found := s.asn.lookup(v4); found {
		c.ASN = entry.ASN
		c.ASName = entry.ASName
		c.Provenance = append(c.Provenance, "geolite2-asn")
	}
	return c
}
