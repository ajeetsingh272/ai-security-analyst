package sentinelenrich

import (
	"fmt"
	"net"
	"sort"
)

// ipv4ToUint32 is the one representation every range table in this
// package keys on — a plain uint32 sorts and binary-searches directly,
// with none of net.IP's own allocation or byte-slice-equality overhead
// on a hot lookup path. IPv6 is out of scope (see Store's own doc
// comment) — a v4-mapped or bare IPv6 address simply returns ok=false,
// the same "not found" as any other unrecognised input.
func ipv4ToUint32(ip net.IP) (uint32, bool) {
	v4 := ip.To4()
	if v4 == nil {
		return 0, false
	}
	return uint32(v4[0])<<24 | uint32(v4[1])<<16 | uint32(v4[2])<<8 | uint32(v4[3]), true
}

// uint32ToIPv4 is ipv4ToUint32's own inverse — used only by this
// package's own integration test, to turn a range's own Start back
// into a dotted-quad string for a real Lookup call.
func uint32ToIPv4(v uint32) string {
	return fmt.Sprintf("%d.%d.%d.%d", v>>24&0xff, v>>16&0xff, v>>8&0xff, v&0xff)
}

// parseIPv4Range parses a "start,end" CSV pair (sapics/ip-location-db's
// own format for both its country and ASN tables) into the uint32 pair
// range tables key on.
func parseIPv4Range(startStr, endStr string) (start, end uint32, err error) {
	s := net.ParseIP(startStr)
	e := net.ParseIP(endStr)
	if s == nil || e == nil {
		return 0, 0, fmt.Errorf("invalid IP range %q-%q", startStr, endStr)
	}
	start, ok1 := ipv4ToUint32(s)
	end, ok2 := ipv4ToUint32(e)
	if !ok1 || !ok2 {
		return 0, 0, fmt.Errorf("range %q-%q is not IPv4", startStr, endStr)
	}
	return start, end, nil
}

// parseIPv4CIDR parses one CIDR line (X4BNet's own VPN/datacenter list
// format) into the [start,end] uint32 pair it spans.
func parseIPv4CIDR(cidr string) (start, end uint32, err error) {
	_, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return 0, 0, err
	}
	ones, bits := network.Mask.Size()
	if bits != 32 {
		return 0, 0, fmt.Errorf("CIDR %q is not IPv4", cidr)
	}
	start, ok := ipv4ToUint32(network.IP)
	if !ok {
		return 0, 0, fmt.Errorf("CIDR %q base address is not IPv4", cidr)
	}
	hostBits := 32 - ones
	size := uint32(1)
	if hostBits > 0 {
		size = uint32(1) << uint(hostBits)
	}
	return start, start + size - 1, nil
}

// addrRange is one [Start,End] inclusive IPv4 range — the shared shape
// every per-feed table below sorts and searches, with whatever payload
// (country code, ASN, or nothing at all for a plain membership set)
// that feed attaches.
type addrRange[T any] struct {
	Start, End uint32
	Value      T
}

// rangeTable is a sorted-by-Start slice searched by binary search —
// correct here depends entirely on construction always calling sortRanges
// before any lookup, which newRangeTable enforces by doing it itself.
type rangeTable[T any] []addrRange[T]

func newRangeTable[T any](ranges []addrRange[T]) rangeTable[T] {
	t := rangeTable[T](ranges)
	sort.Slice(t, func(i, j int) bool { return t[i].Start < t[j].Start })
	return t
}

// lookup finds the range containing addr, if any. Binary search for the
// last range whose Start is <= addr, then confirms addr <= that range's
// End — ranges in every feed this package reads are non-overlapping, so
// there is at most one candidate to check.
func (t rangeTable[T]) lookup(addr uint32) (T, bool) {
	i := sort.Search(len(t), func(i int) bool { return t[i].Start > addr }) - 1
	var zero T
	if i < 0 || i >= len(t) {
		return zero, false
	}
	if addr >= t[i].Start && addr <= t[i].End {
		return t[i].Value, true
	}
	return zero, false
}
