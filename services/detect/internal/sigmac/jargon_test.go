package sigmac

import (
	"strings"
	"testing"
)

// jargonTerms is P2-06's T4: "every rule description is present and
// contains no unexplained jargon, checked by a term allowlist." An
// allowlist of every word a free-form English sentence might use is not
// practically maintainable (it would need to enumerate "a", "the",
// "was", ...); this implements the check as its complement instead — a
// reviewed, explicit list of the SPECIFIC internal/technical terms this
// corpus's own engineering vocabulary tends to reach for (acronyms,
// product internals, Sigma/detection-engineering jargon), any one of
// which failing this test means a rule author wrote the engineer-facing
// Description's own voice into OwnerDescription by mistake. Same
// "explicit, reviewable table, not an implicit judgement call" shape as
// fieldmap.go's own fieldMap.
var jargonTerms = []string{
	"oauth", "mfa", "api", "ocsf", "adr-", "sigma", "uuid", "guid", "upn",
	"json", "yaml", "regex", "webhook", "sso", "saml", "rbac", "iam",
	"cve", "ioc", "ttp", "telemetry", "ingestion", "normalisation",
	"normalization", "schema", "namespace", "cmdlet", "powershell",
	"dlp", "atp", "ediscovery", "pst", "endpoint", "backend", "async",
	"tenant", "metadata", "windowed engine", "in-stream", "dispatch tree",
	"selection", "fieldmap", "clickhouse", "kafka", "redpanda",
}

// T4: every rule's owner-facing description is present (AC4, already
// enforced as a build error by Parse itself) and contains none of the
// terms above, case-insensitively — proven against the real, committed
// corpus, not a synthetic sample.
func TestOwnerDescription_ContainsNoJargon(t *testing.T) {
	rules, errs := ParseCorpus(corpusDir)
	if len(errs) != 0 {
		t.Fatalf("parsing corpus: %v", errs)
	}
	if len(rules) == 0 {
		t.Fatal("expected at least one rule to parse from the committed corpus")
	}

	for _, r := range rules {
		desc := strings.ToLower(r.OwnerDescription)
		for _, term := range jargonTerms {
			if strings.Contains(desc, term) {
				t.Errorf("rule %q: owner_description contains unexplained jargon %q: %q", r.Title, term, r.OwnerDescription)
			}
		}
	}
}
