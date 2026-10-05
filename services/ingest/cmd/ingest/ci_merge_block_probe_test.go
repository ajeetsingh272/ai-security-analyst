// THROWAWAY — proves P0-02 T2: a PR with a deliberately failing Go test is
// blocked from merging. Never merged to main; this file and the branch that
// carries it are deleted once the probe PR confirms the required check fails
// and the merge is blocked.
package main

import "testing"

func TestCIMergeBlockProbeDeliberatelyFails(t *testing.T) {
	t.Fatal("deliberate failure to prove the Go check blocks a merge")
}
