// Package attck is P2-07: a pinned, embedded MITRE ATT&CK Enterprise
// technique catalogue, used to validate every rule's own MITRE tag
// against the real, published matrix (AC1/AC2) and to build the
// coverage report and ATT&CK Navigator layer stakeholders use to see
// gaps rather than assume them (AC3/AC4).
//
// techniques.json is a condensed extract of the official MITRE CTI
// project's attack-stix-data repository (mitre-attack/attack-stix-data),
// pinned at tag v19.2 — the same "compiler pins a spec version;
// upgrades are deliberate" discipline sigmac.SpecVersion already
// applies to the Sigma specification itself. It carries only what this
// package needs per technique (id, name, tactics, deprecated, revoked,
// sub_technique) — not the full ~54MB STIX bundle's relationships,
// groups, software and mitigations, which this package has no use for.
// Regenerating it means re-running the same extraction against a newer
// tagged release, reviewed like any other dependency bump.
package attck

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

// CatalogueVersion is the pinned attack-stix-data release tag
// techniques.json was extracted from.
const CatalogueVersion = "v19.2"

//go:embed techniques.json
var techniquesJSON []byte

// Technique is one ATT&CK technique or sub-technique.
type Technique struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Tactics      []string `json:"tactics"`
	Deprecated   bool     `json:"deprecated"`
	Revoked      bool     `json:"revoked"`
	SubTechnique bool     `json:"sub_technique"`
}

var byID map[string]Technique

func init() {
	var techniques []Technique
	if err := json.Unmarshal(techniquesJSON, &techniques); err != nil {
		panic(fmt.Sprintf("attck: embedded techniques.json is malformed: %v", err))
	}
	byID = make(map[string]Technique, len(techniques))
	for _, t := range techniques {
		byID[t.ID] = t
	}
}

// All returns every technique in the pinned catalogue, including
// deprecated and revoked ones (callers needing only current, valid
// techniques — e.g. the coverage report — filter those out themselves;
// a caller checking "is this ID retired" needs them present).
func All() []Technique {
	out := make([]Technique, 0, len(byID))
	for _, t := range byID {
		out = append(out, t)
	}
	return out
}

// Lookup finds a technique by its ATT&CK ID ("T1110.003" or "T1110" —
// case-insensitive, and tolerant of Sigma's own "attack." tag prefix so
// a caller can pass either form directly).
func Lookup(id string) (Technique, bool) {
	t, ok := byID[NormalizeID(id)]
	return t, ok
}

// NormalizeID turns a Sigma tag ("attack.t1110.003") or a bare,
// differently-cased ATT&CK ID ("t1110.003") into the catalogue's own
// canonical form ("T1110.003").
func NormalizeID(id string) string {
	id = strings.TrimPrefix(strings.ToLower(id), "attack.")
	if id == "" {
		return ""
	}
	return "T" + strings.TrimPrefix(id, "t")
}
