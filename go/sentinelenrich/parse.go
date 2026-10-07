package sentinelenrich

import (
	"bufio"
	"encoding/csv"
	"io"
	"strconv"
	"strings"
)

// parseTorExitList reads the Tor Project's own bulk exit list format
// (https://check.torproject.org/torbulkexitlist) — one IPv4 address per
// line, blank lines and "#"-prefixed comments ignored. Returns exact
// addresses, not ranges: Tor exit nodes are individual hosts, and the
// list already is one IP per line, so there is nothing to collapse into
// ranges.
func parseTorExitList(r io.Reader) (map[string]bool, error) {
	set := make(map[string]bool)
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		set[line] = true
	}
	return set, scanner.Err()
}

// parseCIDRList reads X4BNet's own list format
// (github.com/X4BNet/lists_vpn) — one CIDR per line, blank lines and
// "#"-prefixed comments ignored. A line this package cannot parse as
// an IPv4 CIDR (an IPv6 entry, a malformed line) is skipped rather than
// failing the whole feed — one bad line in a many-thousand-line list
// must not discard every other range it contains.
func parseCIDRList(r io.Reader) (rangeTable[struct{}], error) {
	var ranges []addrRange[struct{}]
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		start, end, err := parseIPv4CIDR(line)
		if err != nil {
			continue
		}
		ranges = append(ranges, addrRange[struct{}]{Start: start, End: end})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return newRangeTable(ranges), nil
}

// parseCountryCSV reads sapics/ip-location-db's own geolite2-country
// format: start_ip,end_ip,country_code per row, no header. A row this
// package cannot parse as an IPv4 range (IPv6, or — per that dataset's
// own documented gap — a row with no resolvable country at all, which
// it represents by omitting the third field) is skipped, the same
// "one bad row doesn't cost every other row" reasoning as the CIDR
// parser above.
func parseCountryCSV(r io.Reader) (rangeTable[string], error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	var ranges []addrRange[string]
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if len(rec) < 3 {
			continue
		}
		start, end, err := parseIPv4Range(rec[0], rec[1])
		if err != nil {
			continue
		}
		ranges = append(ranges, addrRange[string]{Start: start, End: end, Value: rec[2]})
	}
	return newRangeTable(ranges), nil
}

// asnEntry is one ASN range's payload — the two values AC2/AC5 both
// need (the ASN itself, and the registered name a human recognises).
type asnEntry struct {
	ASN    uint32
	ASName string
}

// parseASNCSV reads sapics/ip-location-db's own geolite2-asn format:
// start_ip,end_ip,asn,as_name per row, no header, as_name
// comma-quoted when it itself contains a comma (standard CSV, which is
// exactly why this uses encoding/csv rather than strings.Split).
func parseASNCSV(r io.Reader) (rangeTable[asnEntry], error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	var ranges []addrRange[asnEntry]
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if len(rec) < 4 {
			continue
		}
		start, end, err := parseIPv4Range(rec[0], rec[1])
		if err != nil {
			continue
		}
		asn, err := strconv.ParseUint(rec[2], 10, 32)
		if err != nil {
			continue
		}
		ranges = append(ranges, addrRange[asnEntry]{Start: start, End: end, Value: asnEntry{ASN: uint32(asn), ASName: rec[3]}})
	}
	return newRangeTable(ranges), nil
}
