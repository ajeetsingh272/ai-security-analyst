//go:build integration

package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"testing"
	"time"
)

// T1/T2: these are the two BOUNDED, literally-runnable test cases from
// P1-12's own table — "count reconciliation is exact after an induced
// broker/ClickHouse restart" — as opposed to T3 and the ticket's own
// "runs 72 hours continuously" AC, which this package's own doc comment
// (main.go) explains cannot be executed literally inside a test run. T1
// and T2 need no such compromise: a real restart, induced partway through
// a short run, with exact reconciliation checked afterwards, is the whole
// claim either way — the duration is the only thing that differs between
// a 70-second proof and a 72-hour one.
//
// Needs: `pnpm dev:stack` running (Redpanda + ClickHouse) and a Go
// toolchain on PATH.

// T1
func TestBrokerRestartReconcilesExactly(t *testing.T) {
	runReconciliationTest(t, failureModeBrokerOnly)
}

// T2
func TestClickHouseRestartReconcilesExactly(t *testing.T) {
	runReconciliationTest(t, failureModeClickHouseOnly)
}

func runReconciliationTest(t *testing.T, mode failureMode) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cfg := Config{
		TenantID:       fmt.Sprintf("60000000-0000-4000-8000-%012d", time.Now().UnixNano()%1_000_000_000_000),
		ConnectorRowID: "soak-it-test",
		// RestartEvery > Duration/2 so the ticker fires EXACTLY once (at
		// t=40s) within a 75s run, never a second time at/after t=75 —
		// the first version of this test used Duration=70s/RestartEvery=35s,
		// which fires at both t=35 AND t=70, landing the second restart
		// right as the run window closes and racing reconcile()'s own
		// ClickHouse connection against the container still being down.
		// Found the hard way: that race failed this exact test with
		// "stored=0" and a raw EOF from the driver, not a real
		// reconciliation bug. 35s of post-restart runway (both services
		// were observed recovering within ~10s in manual runs) is ample.
		Duration:     75 * time.Second,
		Interval:     1 * time.Second,
		BatchSize:    100,
		FailRate:     0.1,
		RestartEvery: 40 * time.Second,
		FailureMode:  mode,
	}

	report, err := runSoak(ctx, cancel, cfg, log)
	if err != nil {
		t.Fatalf("runSoak: %v", err)
	}

	if !report.ReconciledExactly {
		t.Fatalf("expected produced count to reconcile exactly with stored count after the induced restart, got produced=%d written=%d stored=%d",
			report.Produced, report.WrittenByConsumer, report.StoredAfterMerge)
	}
	switch mode {
	case failureModeBrokerOnly:
		if report.BrokerRestarts == 0 {
			t.Fatal("expected at least one broker restart to have been injected")
		}
	case failureModeClickHouseOnly:
		if report.ClickHouseRestarts == 0 {
			t.Fatal("expected at least one ClickHouse restart to have been injected")
		}
	}
}
