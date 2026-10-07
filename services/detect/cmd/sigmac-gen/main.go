// Command sigmac-gen is P2-02's own build step: parse every rule in
// detections/rules (P2-01), require a fixture pair for each
// (detections/fixtures), and write the compiled Go predicates plus their
// generated tests to services/detect/internal/detectgen — committed,
// per ADR-0004.
//
// Run via `go generate` or directly:
//
//	go run ./cmd/sigmac-gen
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "sigmac-gen:", err)
		os.Exit(1)
	}
}

func run() error {
	root, err := repoRoot()
	if err != nil {
		return err
	}
	rulesDir := filepath.Join(root, "detections", "rules")
	fixturesDir := filepath.Join(root, "detections", "fixtures")
	outDir := filepath.Join(root, "services", "detect", "internal", "detectgen")

	rules, errs := sigmac.ParseCorpus(rulesDir)
	if len(errs) > 0 {
		for _, e := range errs {
			fmt.Fprintln(os.Stderr, e)
		}
		return fmt.Errorf("%d rule(s) failed to parse", len(errs))
	}

	ruleCode, testCode, err := sigmac.GenerateSource(rules, fixturesDir)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(outDir, "rules.gen.go"), ruleCode, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(outDir, "rules.gen_test.go"), testCode, 0o644); err != nil {
		return err
	}
	fmt.Printf("sigmac-gen: wrote %d compiled rule(s) to %s\n", len(rules), outDir)
	return nil
}

// repoRoot walks up from the working directory to the first ancestor
// containing go.work — this binary is run both via `go run
// ./cmd/sigmac-gen` from services/detect and via CI from the repo root,
// so it cannot assume either.
func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("could not find go.work above %s", dir)
		}
		dir = parent
	}
}
