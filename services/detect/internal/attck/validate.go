package attck

import "fmt"

// ValidationError names exactly which rule, which tag, and why it
// failed — the same "identify the file, line and construct" discipline
// sigmac.ParseError already applies to parse failures, applied here to
// ATT&CK catalogue validation specifically.
type ValidationError struct {
	RuleTitle string
	Tag       string
	Reason    string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("rule %q: MITRE tag %q: %s", e.RuleTitle, e.Tag, e.Reason)
}

// ValidateRuleTags checks every one of a rule's own MITRE tags against
// the pinned catalogue — AC1 ("validated against a pinned ATT&CK
// version at build time"), AC2 ("an invalid or retired technique id
// fails the build"). Unknown, revoked and deprecated are each a
// distinct, named failure reason rather than one generic "invalid",
// since they're different problems a rule author fixes differently
// (unknown: fix a typo; revoked/deprecated: switch to the ID ATT&CK
// itself replaced it with).
func ValidateRuleTags(ruleTitle string, tags []string) []error {
	var errs []error
	for _, tag := range tags {
		t, ok := Lookup(tag)
		if !ok {
			errs = append(errs, &ValidationError{RuleTitle: ruleTitle, Tag: tag, Reason: fmt.Sprintf("not a known ATT&CK technique id in the pinned catalogue (%s)", CatalogueVersion)})
			continue
		}
		if t.Revoked {
			errs = append(errs, &ValidationError{RuleTitle: ruleTitle, Tag: tag, Reason: fmt.Sprintf("%s (%s) has been revoked by ATT&CK — look up its replacement in the %s catalogue", t.ID, t.Name, CatalogueVersion)})
			continue
		}
		if t.Deprecated {
			errs = append(errs, &ValidationError{RuleTitle: ruleTitle, Tag: tag, Reason: fmt.Sprintf("%s (%s) is deprecated in %s", t.ID, t.Name, CatalogueVersion)})
		}
	}
	return errs
}

// Rule is the minimal shape ValidateCorpus needs from a parsed rule —
// kept narrow rather than importing sigmac.Rule directly, so this
// package has no dependency on the parser package at all (only
// services/detect/cmd/sigmac-gen, which already imports both, needs to
// bridge the two).
type Rule interface {
	Title() string
	MitreTags() []string
}

// ValidateCorpus runs ValidateRuleTags over every rule, collecting every
// problem across the whole corpus in one pass — the same "report every
// bad rule, not just the first" discipline sigmac.ParseCorpus already
// uses.
func ValidateCorpus(rules []Rule) []error {
	var errs []error
	for _, r := range rules {
		errs = append(errs, ValidateRuleTags(r.Title(), r.MitreTags())...)
	}
	return errs
}
