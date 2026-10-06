package attck

import "sort"

// TechniqueCoverage is one catalogue technique's own coverage status —
// AC3's "shows which tactics and techniques are and are not covered"
// means every technique in the pinned catalogue appears here, not just
// the ones a rule happens to cover.
type TechniqueCoverage struct {
	Technique
	Covered    bool
	RuleTitles []string
}

// TacticCoverage aggregates TechniqueCoverage by tactic — the other
// half of AC3's own phrasing ("which tactics... are and are not
// covered").
type TacticCoverage struct {
	Tactic  string
	Total   int
	Covered int
}

// Report is the whole corpus-vs-catalogue comparison.
type Report struct {
	CatalogueVersion string
	Techniques       []TechniqueCoverage
	Tactics          []TacticCoverage
}

// CoveredCount is T2's own "coverage report counts match the rule
// corpus" — a single, directly checkable number.
func (r Report) CoveredCount() int {
	n := 0
	for _, t := range r.Techniques {
		if t.Covered {
			n++
		}
	}
	return n
}

// BuildCoverage compares rules' own MITRE tags against every current
// (non-deprecated, non-revoked) technique in the pinned catalogue — a
// rule using a revoked/deprecated id is a ValidateCorpus failure, not a
// coverage question, so this report only ever concerns the techniques a
// rule COULD validly target.
func BuildCoverage(rules []Rule) Report {
	ruleTitlesByTechnique := make(map[string][]string)
	for _, r := range rules {
		for _, tag := range r.MitreTags() {
			id := NormalizeID(tag)
			ruleTitlesByTechnique[id] = append(ruleTitlesByTechnique[id], r.Title())
		}
	}

	var techniques []TechniqueCoverage
	tacticTotals := make(map[string]int)
	tacticCovered := make(map[string]int)

	for _, t := range All() {
		if t.Deprecated || t.Revoked {
			continue
		}
		titles := ruleTitlesByTechnique[t.ID]
		sort.Strings(titles)
		covered := len(titles) > 0
		techniques = append(techniques, TechniqueCoverage{Technique: t, Covered: covered, RuleTitles: titles})
		for _, tactic := range t.Tactics {
			tacticTotals[tactic]++
			if covered {
				tacticCovered[tactic]++
			}
		}
	}
	sort.Slice(techniques, func(i, j int) bool { return techniques[i].ID < techniques[j].ID })

	var tactics []TacticCoverage
	for tactic, total := range tacticTotals {
		tactics = append(tactics, TacticCoverage{Tactic: tactic, Total: total, Covered: tacticCovered[tactic]})
	}
	sort.Slice(tactics, func(i, j int) bool { return tactics[i].Tactic < tactics[j].Tactic })

	return Report{CatalogueVersion: CatalogueVersion, Techniques: techniques, Tactics: tactics}
}
