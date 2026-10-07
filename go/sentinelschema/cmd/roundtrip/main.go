// A tiny CLI used only by packages/schema/scripts/roundtrip-check.mjs
// (P0-11 T2, P3-08 T3): reads a Verdict or a Case as JSON from stdin
// (-type=verdict, the default, or -type=case), unmarshals it into the
// matching generated struct, re-marshals, writes to stdout. Not shipped
// anywhere — its only job is to prove the generated struct's JSON tags
// actually round-trip data the TypeScript side constructs, rather than
// merely looking plausible. This is also T3's own "Go... consumer
// compiles against the frozen contract" — a real Go program that
// imports and uses sentinelschema.Case, not a synthetic claim.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	sentinelschema "github.com/ajeetsingh272/ai-security-analyst/go/sentinelschema"
)

func main() {
	typeFlag := flag.String("type", "verdict", "which generated type to round-trip: verdict or case")
	flag.Parse()

	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "roundtrip: reading stdin:", err)
		os.Exit(1)
	}

	var output []byte
	switch *typeFlag {
	case "verdict":
		var verdict sentinelschema.Verdict
		if err := json.Unmarshal(input, &verdict); err != nil {
			fmt.Fprintln(os.Stderr, "roundtrip: unmarshalling into Verdict:", err)
			os.Exit(1)
		}
		output, err = json.Marshal(verdict)
	case "case":
		var c sentinelschema.Case
		if err := json.Unmarshal(input, &c); err != nil {
			fmt.Fprintln(os.Stderr, "roundtrip: unmarshalling into Case:", err)
			os.Exit(1)
		}
		output, err = json.Marshal(c)
	default:
		fmt.Fprintf(os.Stderr, "roundtrip: unknown -type %q (want verdict or case)\n", *typeFlag)
		os.Exit(1)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "roundtrip: marshalling:", err)
		os.Exit(1)
	}

	os.Stdout.Write(output)
}
