package sigmac

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// ParseError is this package's own error type — AC2/AC5's "identify the
// file, line and construct" requirement, and T2's "precise, actionable
// error" requirement, made checkable rather than just a hopeful string
// format. Line is 0 when a failure isn't tied to one YAML node specifically
// (e.g. a missing top-level field).
type ParseError struct {
	File      string
	Line      int
	Construct string
	Rule      string
	Err       error
}

func (e *ParseError) Error() string {
	loc := e.File
	if e.Line > 0 {
		loc = fmt.Sprintf("%s:%d", e.File, e.Line)
	}
	rule := e.Rule
	if rule == "" {
		rule = "(unknown rule)"
	}
	return fmt.Sprintf("%s: rule %q: %s: %v", loc, rule, e.Construct, e.Err)
}

func (e *ParseError) Unwrap() error { return e.Err }

// ParseFile reads and parses one Sigma rule YAML file.
func ParseFile(path string) (*Rule, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, &ParseError{File: path, Construct: "reading file", Err: err}
	}
	return Parse(path, data)
}

// Parse parses one Sigma rule's YAML bytes. file is used only for error
// messages (AC5) — this function does no I/O itself, which is what lets
// it be unit-tested against in-memory fixtures without a filesystem.
func Parse(file string, data []byte) (*Rule, error) {
	var node yaml.Node
	if err := yaml.Unmarshal(data, &node); err != nil {
		return nil, &ParseError{File: file, Construct: "YAML syntax", Err: err}
	}
	var raw rawRule
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, &ParseError{File: file, Construct: "YAML structure", Err: err}
	}
	// AC5/T2: "parse errors identify the file, line and construct" — this
	// walks the raw YAML node tree (not rawRule, which already discarded
	// position info by the time it's a plain Go map) to recover the
	// source line of each selection's own field key, the one place a
	// rule author is most likely to hit an unsupported construct.
	fieldLines := findFieldLines(&node)

	if raw.Title == "" {
		return nil, &ParseError{File: file, Construct: "required field 'title'", Err: fmt.Errorf("missing")}
	}
	if raw.ID == "" {
		return nil, &ParseError{File: file, Rule: raw.Title, Construct: "required field 'id'", Err: fmt.Errorf("missing")}
	}
	if raw.Level == "" {
		return nil, &ParseError{File: file, Rule: raw.Title, Construct: "required field 'level'", Err: fmt.Errorf("missing")}
	}

	mitreIDs := extractMitreIDs(raw.Tags)
	if len(mitreIDs) == 0 {
		return nil, &ParseError{File: file, Rule: raw.Title, Construct: "MITRE ATT&CK tag", Err: fmt.Errorf("every rule must declare at least one attack.<technique-id> tag (ADR-0004)")}
	}

	if raw.Detection == nil {
		return nil, &ParseError{File: file, Rule: raw.Title, Construct: "required field 'detection'", Err: fmt.Errorf("missing")}
	}
	conditionRaw, ok := raw.Detection["condition"]
	if !ok {
		return nil, &ParseError{File: file, Rule: raw.Title, Construct: "detection.condition", Err: fmt.Errorf("missing")}
	}
	conditionStr, ok := conditionRaw.(string)
	if !ok {
		return nil, &ParseError{File: file, Rule: raw.Title, Construct: "detection.condition", Err: fmt.Errorf("must be a string, got %T", conditionRaw)}
	}

	selections := make(map[string]Selection)
	for key, val := range raw.Detection {
		if key == "condition" {
			continue
		}
		fields, ok := val.(map[string]any)
		if !ok {
			return nil, &ParseError{File: file, Rule: raw.Title, Construct: fmt.Sprintf("selection %q", key), Err: fmt.Errorf("must be a mapping of field names to values, got %T", val)}
		}
		sel, badKey, err := parseSelection(key, fields)
		if err != nil {
			return nil, &ParseError{File: file, Rule: raw.Title, Line: fieldLines[key+"|"+badKey], Construct: fmt.Sprintf("selection %q", key), Err: err}
		}
		selections[key] = sel
	}
	if len(selections) == 0 {
		return nil, &ParseError{File: file, Rule: raw.Title, Construct: "detection", Err: fmt.Errorf("no selections defined")}
	}

	cond, err := parseCondition(conditionStr)
	if err != nil {
		return nil, &ParseError{File: file, Rule: raw.Title, Construct: "condition expression", Err: err}
	}
	if err := validateConditionRefs(cond, selections); err != nil {
		return nil, &ParseError{File: file, Rule: raw.Title, Construct: "condition expression", Err: err}
	}

	agg, err := parseAggregation(conditionStr)
	if err != nil {
		return nil, &ParseError{File: file, Rule: raw.Title, Construct: "aggregation clause", Err: err}
	}
	engine := EngineInStream
	if agg != nil {
		engine = EngineWindowed
		for _, f := range agg.GroupBy {
			if _, ok := mapField(f); !ok {
				return nil, &ParseError{File: file, Rule: raw.Title, Construct: fmt.Sprintf("aggregation group-by field %q", f), Err: fmt.Errorf("not in the field mapping table (fieldmap.go)")}
			}
		}
	}

	return &Rule{
		ID:          raw.ID,
		Title:       raw.Title,
		Level:       raw.Level,
		MitreIDs:    mitreIDs,
		LogSource:   LogSource{Category: raw.LogSource.Category, Product: raw.LogSource.Product, Service: raw.LogSource.Service},
		Selections:  selections,
		Condition:   cond,
		Engine:      engine,
		Aggregation: agg,
		SpecVersion: SpecVersion,
		SourceFile:  file,
	}, nil
}

// parseSelection turns one selection's raw field->value mapping into a
// Selection — AC1's modifier support (contains, startswith, endswith, re,
// all, base64) and AC2's "unsupported construct" rejection both live
// here, since a field's "|"-suffixed modifiers are exactly where a rule
// author would reach for something this subset doesn't support.
func parseSelection(name string, fields map[string]any) (sel Selection, badKey string, err error) {
	sel = Selection{Name: name}
	// Sorted purely so error messages and iteration order are
	// deterministic across runs — map iteration order is not, and a
	// flaky-looking error message for a genuinely invalid rule is its
	// own kind of bug.
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, key := range keys {
		fieldName, modifier, allOf, err := parseFieldKey(key)
		if err != nil {
			return Selection{}, key, err
		}
		ocsfPath, ok := mapField(fieldName)
		if !ok {
			return Selection{}, key, fmt.Errorf("field %q has no entry in the OCSF field mapping table (fieldmap.go) — AC4: this is an error, not a silent no-match", fieldName)
		}
		values, err := toValueList(fields[key])
		if err != nil {
			return Selection{}, key, fmt.Errorf("field %q: %w", fieldName, err)
		}
		sel.Fields = append(sel.Fields, FieldMatch{
			SigmaField: fieldName,
			OCSFPath:   ocsfPath,
			Modifier:   modifier,
			Values:     values,
			AllOf:      allOf,
		})
	}
	return sel, "", nil
}

// findFieldLines walks the raw YAML document node for exactly the shape
// Parse needs line numbers from: detection.<selectionName>.<fieldKey>'s
// own key node. Returns a map keyed "selectionName|fieldKey" -> line.
// Deliberately narrow (not a general YAML-path-to-line utility) — this
// package has exactly one place that needs it.
func findFieldLines(doc *yaml.Node) map[string]int {
	lines := make(map[string]int)
	if len(doc.Content) == 0 {
		return lines
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return lines
	}
	detection := mappingValue(root, "detection")
	if detection == nil || detection.Kind != yaml.MappingNode {
		return lines
	}
	for i := 0; i+1 < len(detection.Content); i += 2 {
		selKey, selVal := detection.Content[i], detection.Content[i+1]
		if selKey.Value == "condition" || selVal.Kind != yaml.MappingNode {
			continue
		}
		for j := 0; j+1 < len(selVal.Content); j += 2 {
			fieldKey := selVal.Content[j]
			lines[selKey.Value+"|"+fieldKey.Value] = fieldKey.Line
		}
	}
	return lines
}

// mappingValue returns the value node for key in a YAML mapping node, or
// nil if absent — yaml.Node's own Content is a flat [key, value, key,
// value, ...] slice with no lookup helper of its own.
func mappingValue(mapping *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			return mapping.Content[i+1]
		}
	}
	return nil
}

var supportedModifiers = map[string]Modifier{
	"contains":   ModContains,
	"startswith": ModStartsWith,
	"endswith":   ModEndsWith,
	"re":         ModRegex,
	"base64":     ModBase64,
}

// parseFieldKey splits a detection field key like "CommandLine|contains|all"
// into its bare field name and modifiers — AC2's own loud-rejection path
// for any modifier token this subset doesn't recognise, or for
// nonsensically combining two single-value modifiers (e.g.
// "Field|contains|endswith", which real Sigma also does not define).
func parseFieldKey(key string) (field string, modifier Modifier, allOf bool, err error) {
	parts := strings.Split(key, "|")
	field = parts[0]
	modifier = ModEquals
	haveModifier := false
	for _, m := range parts[1:] {
		if strings.EqualFold(m, "all") {
			allOf = true
			continue
		}
		mod, ok := supportedModifiers[strings.ToLower(m)]
		if !ok {
			return "", 0, false, fmt.Errorf("unsupported modifier %q on field %q (supported: contains, startswith, endswith, re, all, base64)", m, field)
		}
		if haveModifier {
			return "", 0, false, fmt.Errorf("field %q combines two value modifiers; this subset supports at most one of contains/startswith/endswith/re/base64 per field, plus 'all'", field)
		}
		modifier = mod
		haveModifier = true
	}
	return field, modifier, allOf, nil
}

// toValueList normalises a YAML field value — a scalar or a list of
// scalars — into a string slice. Every scalar is stringified rather than
// type-switched into a narrower comparison later: Sigma itself treats
// `EventID: 4625` and `EventID: '4625'` identically, and the evaluator
// this package feeds (P2-03/04) compares against string-valued OCSF
// fields regardless.
func toValueList(v any) ([]string, error) {
	switch vv := v.(type) {
	case []any:
		out := make([]string, 0, len(vv))
		for _, item := range vv {
			s, err := scalarToString(item)
			if err != nil {
				return nil, err
			}
			out = append(out, s)
		}
		return out, nil
	default:
		s, err := scalarToString(v)
		if err != nil {
			return nil, err
		}
		return []string{s}, nil
	}
}

func scalarToString(v any) (string, error) {
	switch s := v.(type) {
	case string:
		return s, nil
	case int:
		return strconv.Itoa(s), nil
	case bool:
		return strconv.FormatBool(s), nil
	case float64:
		return strconv.FormatFloat(s, 'f', -1, 64), nil
	case nil:
		return "", nil
	default:
		return "", fmt.Errorf("unsupported value type %T (want a string, number, boolean, or a list of those)", v)
	}
}

// extractMitreIDs reads every `attack.tNNNN[.NNN]`-shaped tag — Sigma's
// own convention for attaching a MITRE ATT&CK technique to a rule.
// ADR-0004: "Every rule must declare a MITRE ATT&CK technique; the
// compiler fails the build if one is missing" — enforced by Parse
// itself returning an error when this comes back empty, not by a caller
// remembering to check.
func extractMitreIDs(tags []string) []string {
	var ids []string
	for _, t := range tags {
		if strings.HasPrefix(strings.ToLower(t), "attack.t") {
			ids = append(ids, t)
		}
	}
	return ids
}

// validateConditionRefs walks the condition AST and confirms every named
// selection (and every wildcard pattern's expansion) actually exists —
// AC2's "unsupported construct" rejection applied to condition
// expressions specifically: a typo'd selection name is exactly the kind
// of mistake that must fail the build, not silently evaluate to "always
// false".
func validateConditionRefs(expr ConditionExpr, selections map[string]Selection) error {
	switch e := expr.(type) {
	case SelectionRef:
		if _, ok := selections[e.Name]; !ok {
			return fmt.Errorf("condition references selection %q, which is not defined", e.Name)
		}
	case OfExpr:
		matches := matchSelectionPattern(e.Pattern, selections)
		if len(matches) == 0 {
			return fmt.Errorf("condition's %q pattern matches no defined selection", e.Pattern)
		}
	case NotExpr:
		return validateConditionRefs(e.X, selections)
	case AndExpr:
		if err := validateConditionRefs(e.X, selections); err != nil {
			return err
		}
		return validateConditionRefs(e.Y, selections)
	case OrExpr:
		if err := validateConditionRefs(e.X, selections); err != nil {
			return err
		}
		return validateConditionRefs(e.Y, selections)
	default:
		return fmt.Errorf("unsupported condition construct %T", expr)
	}
	return nil
}

// matchSelectionPattern expands Sigma's own "*" wildcard (e.g.
// "selection*") against every defined selection name — used by both
// validateConditionRefs and (in a later ticket) the evaluator itself,
// which is why it is exported-within-package rather than inlined.
func matchSelectionPattern(pattern string, selections map[string]Selection) []string {
	if !strings.Contains(pattern, "*") {
		if _, ok := selections[pattern]; ok {
			return []string{pattern}
		}
		return nil
	}
	prefix := strings.TrimSuffix(pattern, "*")
	var out []string
	names := make([]string, 0, len(selections))
	for name := range selections {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if strings.HasPrefix(name, prefix) {
			out = append(out, name)
		}
	}
	return out
}

// ParseCorpus parses every *.yml/*.yaml file directly inside dir — T1's
// "parses every rule in the committed corpus without error". Returns
// every successfully parsed Rule AND every error encountered, rather
// than stopping at the first failure, so a corpus-wide lint run reports
// every bad rule in one pass instead of one per CI run.
func ParseCorpus(dir string) ([]*Rule, []error) {
	var rules []*Rule
	var errs []error

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, []error{fmt.Errorf("reading corpus directory %s: %w", dir, err)}
	}
	var files []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if ext == ".yml" || ext == ".yaml" {
			files = append(files, filepath.Join(dir, e.Name()))
		}
	}
	sort.Strings(files)

	for _, f := range files {
		rule, err := ParseFile(f)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		rules = append(rules, rule)
	}
	return rules, errs
}
