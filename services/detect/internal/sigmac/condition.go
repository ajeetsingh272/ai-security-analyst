package sigmac

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// This file is the condition DSL's entire grammar — Sigma's own
// `condition:` string, a small boolean algebra over selection names, plus
// this package's own pipe-suffixed extension for aggregation (AC1's
// "near/aggregation detection for routing to the windowed engine").
// Supported grammar, precedence lowest to highest:
//
//	expr       := orExpr
//	orExpr     := andExpr ("or" andExpr)*
//	andExpr    := notExpr ("and" notExpr)*
//	notExpr    := "not" notExpr | primary
//	primary    := IDENT | ofExpr | "(" expr ")"
//	ofExpr     := (NUMBER | "all") "of" IDENT
//
// IDENT may contain Sigma's own "*" wildcard (e.g. "selection*"), matched
// against every selection whose name fits the pattern — a plain IDENT
// with no wildcard is just a SelectionRef naming exactly one selection.
//
// The aggregation extension, parsed by parseAggregation below rather than
// by this expression grammar (it governs ENGINE ROUTING, not boolean
// truth, so it is deliberately not part of the AST a rule's selections
// evaluate against):
//
//	condition: <expr> | count() by FIELD [, FIELD]* COMPARATOR NUMBER [within DURATION]
//
// e.g. `selection | count() by UserId > 5 within 10m`. <expr> still
// identifies which selection(s) feed the aggregation; COMPARATOR is one
// of < <= > >= ==.
type conditionParser struct {
	tokens []string
	pos    int
}

// tokenizeCondition splits a condition string into tokens — identifiers
// (selection names, numbers, "*"-containing patterns), and the fixed set
// of punctuation/operators this grammar uses. Deliberately simple: Sigma
// condition strings are short and have no quoting or escaping to worry
// about.
func tokenizeCondition(s string) []string {
	var tokens []string
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			tokens = append(tokens, cur.String())
			cur.Reset()
		}
	}
	for _, r := range s {
		switch {
		case r == '(' || r == ')' || r == '|' || r == ',':
			flush()
			tokens = append(tokens, string(r))
		case r == '>' || r == '<' || r == '=':
			flush()
			// Greedily merge with a preceding comparator char already
			// flushed as its own token (">=" arrives as '>' then '=').
			if len(tokens) > 0 && (tokens[len(tokens)-1] == ">" || tokens[len(tokens)-1] == "<") && r == '=' {
				tokens[len(tokens)-1] += "="
			} else {
				tokens = append(tokens, string(r))
			}
		case r == ' ' || r == '\t' || r == '\n':
			flush()
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return tokens
}

// parseCondition parses the boolean-algebra half of a condition string —
// everything before a top-level "|", if any.
func parseCondition(expr string) (ConditionExpr, error) {
	boolPart, _, _ := strings.Cut(expr, "|")
	toks := tokenizeCondition(boolPart)
	if len(toks) == 0 {
		return nil, fmt.Errorf("empty condition")
	}
	p := &conditionParser{tokens: toks}
	ast, err := p.parseOr()
	if err != nil {
		return nil, err
	}
	if p.pos != len(p.tokens) {
		return nil, fmt.Errorf("unexpected token %q after a complete condition", p.tokens[p.pos])
	}
	return ast, nil
}

func (p *conditionParser) peek() string {
	if p.pos >= len(p.tokens) {
		return ""
	}
	return p.tokens[p.pos]
}

func (p *conditionParser) next() string {
	t := p.peek()
	p.pos++
	return t
}

func (p *conditionParser) parseOr() (ConditionExpr, error) {
	left, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for strings.EqualFold(p.peek(), "or") {
		p.next()
		right, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		left = OrExpr{X: left, Y: right}
	}
	return left, nil
}

func (p *conditionParser) parseAnd() (ConditionExpr, error) {
	left, err := p.parseNot()
	if err != nil {
		return nil, err
	}
	for strings.EqualFold(p.peek(), "and") {
		p.next()
		right, err := p.parseNot()
		if err != nil {
			return nil, err
		}
		left = AndExpr{X: left, Y: right}
	}
	return left, nil
}

func (p *conditionParser) parseNot() (ConditionExpr, error) {
	if strings.EqualFold(p.peek(), "not") {
		p.next()
		x, err := p.parseNot()
		if err != nil {
			return nil, err
		}
		return NotExpr{X: x}, nil
	}
	return p.parsePrimary()
}

func (p *conditionParser) parsePrimary() (ConditionExpr, error) {
	tok := p.peek()
	if tok == "" {
		return nil, fmt.Errorf("expected a selection name, 'not', 'all'/a number ('N of ...'), or '(', found end of condition")
	}
	if tok == "(" {
		p.next()
		inner, err := p.parseOr()
		if err != nil {
			return nil, err
		}
		if p.peek() != ")" {
			return nil, fmt.Errorf("expected ')' to close '(', found %q", p.peek())
		}
		p.next()
		return inner, nil
	}

	// "N of pattern" / "all of pattern".
	if strings.EqualFold(tok, "all") || isNumberToken(tok) {
		count := -1
		if !strings.EqualFold(tok, "all") {
			n, err := strconv.Atoi(tok)
			if err != nil {
				return nil, fmt.Errorf("expected a number or 'all' before 'of', found %q", tok)
			}
			count = n
		}
		p.next()
		if !strings.EqualFold(p.peek(), "of") {
			return nil, fmt.Errorf("expected 'of' after %q, found %q", tok, p.peek())
		}
		p.next()
		pattern := p.peek()
		if pattern == "" {
			return nil, fmt.Errorf("expected a selection pattern after 'of', found end of condition")
		}
		p.next()
		return OfExpr{Count: count, Pattern: pattern}, nil
	}

	if isReservedConditionWord(tok) {
		return nil, fmt.Errorf("expected a selection name, found reserved word %q", tok)
	}

	// A bare identifier — one selection name.
	p.next()
	return SelectionRef{Name: tok}, nil
}

// isReservedConditionWord rejects a keyword appearing where a selection
// name is expected (e.g. a malformed "and and b") — found by T2's own
// malformed-condition test, which caught parsePrimary silently accepting
// "and" itself as a selection name before this check existed.
func isReservedConditionWord(tok string) bool {
	switch strings.ToLower(tok) {
	case "and", "or", "not", "of", "by", "within":
		return true
	default:
		return false
	}
}

func isNumberToken(s string) bool {
	_, err := strconv.Atoi(s)
	return err == nil
}

// parseAggregation parses the pipe-suffixed aggregation extension (this
// file's own doc comment has the grammar) and returns nil if the
// condition has no "|" at all — the common, in-stream case.
func parseAggregation(expr string) (*Aggregation, error) {
	_, pipePart, found := strings.Cut(expr, "|")
	if !found {
		return nil, nil
	}
	toks := tokenizeCondition(pipePart)
	i := 0
	expectTok := func(want string) error {
		if i >= len(toks) || !strings.EqualFold(toks[i], want) {
			got := ""
			if i < len(toks) {
				got = toks[i]
			}
			return fmt.Errorf("expected %q in aggregation clause, found %q", want, got)
		}
		i++
		return nil
	}

	if err := expectTok("count"); err != nil {
		return nil, err
	}
	if err := expectTok("("); err != nil {
		return nil, err
	}
	if err := expectTok(")"); err != nil {
		return nil, err
	}
	if err := expectTok("by"); err != nil {
		return nil, err
	}

	var groupBy []string
	for {
		if i >= len(toks) {
			return nil, fmt.Errorf("expected a field name after 'by' in aggregation clause")
		}
		groupBy = append(groupBy, toks[i])
		i++
		if i < len(toks) && toks[i] == "," {
			i++
			continue
		}
		break
	}

	if i >= len(toks) {
		return nil, fmt.Errorf("expected a comparator (<, <=, >, >=, ==) after the aggregation's 'by' fields")
	}
	comparator := toks[i]
	switch comparator {
	case "<", "<=", ">", ">=", "==":
	default:
		return nil, fmt.Errorf("unsupported aggregation comparator %q (want one of < <= > >= ==)", comparator)
	}
	i++

	if i >= len(toks) {
		return nil, fmt.Errorf("expected a threshold number after the aggregation comparator")
	}
	threshold, err := strconv.Atoi(toks[i])
	if err != nil {
		return nil, fmt.Errorf("expected a threshold number after the aggregation comparator, found %q", toks[i])
	}
	i++

	window := 5 * time.Minute // a documented default when no "within" clause is given
	if i < len(toks) {
		if err := expectTok("within"); err != nil {
			return nil, err
		}
		if i >= len(toks) {
			return nil, fmt.Errorf("expected a duration after 'within'")
		}
		d, err := time.ParseDuration(toks[i])
		if err != nil {
			return nil, fmt.Errorf("invalid duration %q after 'within': %w", toks[i], err)
		}
		window = d
		i++
	}

	if i != len(toks) {
		return nil, fmt.Errorf("unexpected trailing content %q in aggregation clause", strings.Join(toks[i:], " "))
	}

	return &Aggregation{GroupBy: groupBy, Op: "count", Comparator: comparator, Threshold: threshold, Window: window}, nil
}
