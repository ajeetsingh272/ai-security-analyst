package customerrules

import "github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"

// ValidateAgainstFixtures is ADR-0012 §3 — the exact same fixture
// requirement sigmac.LoadFixture already enforces for the compiled
// corpus, applied here at activation time against the exact same
// reference interpreter (sigmac.Evaluate) rather than at build time,
// since this path has no build step to gate on. A rule failing either
// check is never activated.
func ValidateAgainstFixtures(r *sigmac.Rule, positive, negative sigmac.Event) error {
	if !sigmac.Evaluate(r, positive) {
		return rejectf("rule %q does not match its own positive fixture", r.Title)
	}
	if sigmac.Evaluate(r, negative) {
		return rejectf("rule %q matches its own negative fixture, which it must not", r.Title)
	}
	return nil
}
