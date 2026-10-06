// A tiny CLI used only by packages/schema/scripts/roundtrip-check.mjs
// (P0-11 T2): reads a Verdict as JSON from stdin, unmarshals it into the
// generated struct, re-marshals, writes to stdout. Not shipped anywhere —
// its only job is to prove the generated struct's JSON tags actually
// round-trip data the TypeScript side constructs, rather than merely
// looking plausible.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	sentinelschema "github.com/ajeetsingh272/ai-security-analyst/go/sentinelschema"
)

func main() {
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "roundtrip: reading stdin:", err)
		os.Exit(1)
	}

	var verdict sentinelschema.Verdict
	if err := json.Unmarshal(input, &verdict); err != nil {
		fmt.Fprintln(os.Stderr, "roundtrip: unmarshalling into Verdict:", err)
		os.Exit(1)
	}

	output, err := json.Marshal(verdict)
	if err != nil {
		fmt.Fprintln(os.Stderr, "roundtrip: marshalling Verdict:", err)
		os.Exit(1)
	}

	os.Stdout.Write(output)
}
