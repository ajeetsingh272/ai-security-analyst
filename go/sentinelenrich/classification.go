// Package sentinelenrich is P2-09: local, scheduled-refresh IP
// classification and geolocation — "detection never makes a synchronous
// external call" (AC1) is the one property every type in this package
// exists to guarantee. Lookup always reads an already-loaded, in-memory
// Store; the only network calls this package ever makes happen in the
// background, on Refresher's own ticker, never on a caller's goroutine.
package sentinelenrich

// Classification is what a single IP address resolves to against the
// currently loaded feeds. Every field is independently optional —
// Country/ASN empty and the three bool flags false, together, mean
// "not found in any feed", not an error (an address absent from every
// feed is the overwhelmingly common case, not a failure of this
// package).
type Classification struct {
	IP string

	// IsTorExit, IsVPN, IsHosting are AC3's own "available as a rule
	// predicate" — Tor exits are matched as exact addresses (the Tor
	// Project's own bulk exit list is exact IPs, not ranges); VPN and
	// hosting are matched as CIDR ranges (X4BNet's own maintained lists).
	IsTorExit bool
	IsVPN     bool
	IsHosting bool

	// Country/ASN/ASName are AC2's own "geolocation and ASN... attached
	// to every sign-in event."
	Country string
	ASN     uint32
	ASName  string

	// Provenance names which feed(s) produced a non-empty result above —
	// AC5's own "a report can cite which feed flagged an address."
	Provenance []string
}

// Anonymiser reports whether this address is classified as hiding the
// real origin of a connection by any means this package tracks — the
// one predicate anonymous-proxy-signin.yml actually needs (AC3), kept
// as a method rather than requiring every caller to repeat "IsTorExit
// || IsVPN" and risk two call sites disagreeing about what "anonymiser"
// means.
func (c Classification) Anonymiser() bool {
	return c.IsTorExit || c.IsVPN
}
