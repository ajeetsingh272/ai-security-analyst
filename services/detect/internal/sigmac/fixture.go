package sigmac

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Fixture is one rule's required pair (AC: "Compilation fails if a rule
// lacks either fixture") — Positive must make the rule's condition true,
// Negative must not. Two separate files per rule
// (<ruleID>.positive.json, <ruleID>.negative.json), each just the flat
// event map directly — the convention CONTRIBUTING.md and
// scripts/validate-detections.sh already document and enforce, kept
// identical here rather than inventing a second, competing fixture
// format for this package's own convenience.
type Fixture struct {
	Positive Event
	Negative Event
}

// LoadFixture reads dir/<ruleID>.positive.json and
// dir/<ruleID>.negative.json. A missing file or invalid JSON in either
// is an error — never a silently-skipped fixture, which is exactly what
// this ticket's AC (and T3) exist to prevent.
func LoadFixture(dir, ruleID string) (*Fixture, error) {
	positive, err := loadEventFile(filepath.Join(dir, ruleID+".positive.json"))
	if err != nil {
		return nil, err
	}
	negative, err := loadEventFile(filepath.Join(dir, ruleID+".negative.json"))
	if err != nil {
		return nil, err
	}
	return &Fixture{Positive: positive, Negative: negative}, nil
}

func loadEventFile(path string) (Event, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading fixture %s: %w", path, err)
	}
	var ev Event
	if err := json.Unmarshal(data, &ev); err != nil {
		return nil, fmt.Errorf("parsing fixture %s: %w", path, err)
	}
	return ev, nil
}
