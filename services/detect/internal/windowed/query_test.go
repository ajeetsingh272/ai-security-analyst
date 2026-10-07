package windowed

import (
	"strings"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
)

const corpusDir = "../../../../detections/rules"

func parseRule(t *testing.T, slug string) *sigmac.Rule {
	t.Helper()
	rules, errs := sigmac.ParseCorpus(corpusDir)
	if len(errs) != 0 {
		t.Fatalf("parsing corpus: %v", errs)
	}
	for _, r := range rules {
		if r.Slug == slug {
			return r
		}
	}
	t.Fatalf("no rule with slug %q in %s", slug, corpusDir)
	return nil
}

func TestBuildQuery_AllThreeWindowedRulesCompile(t *testing.T) {
	for _, slug := range []string{"impossible-travel", "mass-mailbox-download", "mass-file-download"} {
		t.Run(slug, func(t *testing.T) {
			r := parseRule(t, slug)
			if r.Engine != sigmac.EngineWindowed {
				t.Fatalf("rule %s: Engine = %v, want EngineWindowed", slug, r.Engine)
			}
			q, err := BuildQuery(r)
			if err != nil {
				t.Fatalf("BuildQuery(%s): %v", slug, err)
			}
			if !strings.Contains(q.SQL, "FROM sentinel.events") {
				t.Errorf("BuildQuery(%s).SQL does not query sentinel.events: %s", slug, q.SQL)
			}
			// Every bind arg must be accounted for: the number of `?` in
			// SQL must equal len(Args(...)) exactly, or clickhouse-go
			// itself would reject the query at execution time.
			placeholders := strings.Count(q.SQL, "?")
			args := q.Args(time.Now(), time.Now())
			if placeholders != len(args) {
				t.Errorf("BuildQuery(%s).SQL has %d placeholders but Args() returns %d values:\nSQL: %s\nargs: %v", slug, placeholders, len(args), q.SQL, args)
			}
		})
	}
}

func TestBuildQuery_ImpossibleTravel_GroupsByUserCountsDistinctIP(t *testing.T) {
	r := parseRule(t, "impossible-travel")
	q, err := BuildQuery(r)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}
	if !strings.Contains(q.SQL, "count(DISTINCT unmapped[?])") {
		t.Errorf("expected a count(DISTINCT unmapped[?]) aggregate (ClientIP), got: %s", q.SQL)
	}
	if !strings.Contains(q.SQL, "GROUP BY tenant_id, group_key") {
		t.Errorf("expected GROUP BY tenant_id, group_key, got: %s", q.SQL)
	}
	if !strings.Contains(q.SQL, "HAVING agg_value > ?") {
		t.Errorf("expected HAVING agg_value > ? (Comparator \">\"), got: %s", q.SQL)
	}
}

func TestBuildQuery_MassFileDownload_ORsTwoSelections(t *testing.T) {
	r := parseRule(t, "mass-file-download")
	q, err := BuildQuery(r)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}
	if !strings.Contains(q.SQL, " OR ") {
		t.Errorf("expected the OR of selection1/selection2 to appear in SQL, got: %s", q.SQL)
	}
}

// T3: query parameterisation resists an injection attempt via
// tenant-controlled input. A rule's own literal values (Operation
// strings, ResultStatus) are author-controlled, not tenant-controlled —
// but this proves the STRUCTURAL guarantee that matters regardless of
// who controls a value: BuildQuery never formats ANY FieldMatch value,
// map key, or threshold into the SQL text itself. A classic injection
// payload used as a rule's own comparison value must appear ONLY in
// Args(), never in SQL.
func TestBuildQuery_NeverInlinesFieldValues(t *testing.T) {
	payload := `'; DROP TABLE sentinel.events; --`
	r := &sigmac.Rule{
		ID: "injection-probe", Slug: "injection-probe", Title: "probe", Level: "high",
		MitreIDs:  []string{"attack.t1078"},
		LogSource: sigmac.LogSource{Product: "m365"},
		Selections: map[string]sigmac.Selection{
			"selection": {Name: "selection", Fields: []sigmac.FieldMatch{
				{SigmaField: "Operation", OCSFPath: "metadata.operation", Modifier: sigmac.ModEquals, Values: []string{payload}},
			}},
		},
		Condition: sigmac.SelectionRef{Name: "selection"},
		Engine:    sigmac.EngineWindowed,
		Aggregation: &sigmac.Aggregation{
			GroupBy: []string{"UserId"}, Op: "count", Comparator: ">", Threshold: 1, Window: 10 * time.Minute,
		},
	}

	q, err := BuildQuery(r)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}
	if strings.Contains(q.SQL, payload) {
		t.Fatalf("payload leaked directly into SQL text: %s", q.SQL)
	}
	if strings.Contains(q.SQL, "DROP TABLE") {
		t.Fatalf("payload fragment leaked into SQL text: %s", q.SQL)
	}

	args := q.Args(time.Now(), time.Now())
	found := false
	for _, a := range args {
		if s, ok := a.(string); ok && s == payload {
			found = true
		}
	}
	if !found {
		t.Fatalf("payload did not appear as a bind argument at all — Args() = %v", args)
	}
}

// Also probe the map-KEY side (the raw-field-name -> unmapped['<key>']
// translation) — a group-by field name is also never expected to be
// tenant-controlled, but the same structural guarantee applies: the key
// is a bind arg ("unmapped[?]"), never a quoted literal built from a Go
// string.
func TestBuildQuery_NeverInlinesMapKeys(t *testing.T) {
	r := parseRule(t, "mass-mailbox-download")
	q, err := BuildQuery(r)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}
	if strings.Contains(q.SQL, "'UserId'") || strings.Contains(q.SQL, `"UserId"`) {
		t.Fatalf("map key appears as a quoted literal rather than a bind arg: %s", q.SQL)
	}
	if !strings.Contains(q.SQL, "unmapped[?]") {
		t.Fatalf("expected unmapped[?] (parameterised map access), got: %s", q.SQL)
	}
}
