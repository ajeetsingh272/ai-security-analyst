// Command loadtest is P2-11's own harness entry point — "30k EPS
// sustained for one hour, p99 under 100ms, no goroutine/memory leak" as
// an executable, repeatable test, matching go/soaktest's own convention
// (a Config struct, callable identically from here and from an
// integration test with a shorter duration).
//
// A literal "30k EPS for one hour" is not something every CI run should
// pay for — see go/soaktest's own doc comment for the identical
// reasoning. This binary has no hardcoded ceiling on either knob:
//
//	go run ./services/detect/cmd/loadtest -eps=30000 -duration=1h
//
// runs the full acceptance scale for real; the CI regression gate
// (services/detect/internal/loadtest/harness_integration_test.go) calls
// Run directly with a short duration and a reduced EPS instead, so a
// regression is still caught on every PR without blocking it for an hour.
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/loadtest"
)

func main() {
	eps := flag.Int("eps", 30000, "target events per second, across every worker combined")
	duration := flag.Duration("duration", 1*time.Hour, "how long to sustain the target rate — the ticket's own AC asks for 1h")
	workers := flag.Int("workers", 4, "number of real Worker instances sharing one consumer group")
	matchEveryN := flag.Int("match-every-n", 500, "1 event in N is crafted to match a real rule, so latency and the signal-publish path are measured, not just raw throughput")
	brokers := flag.String("brokers", "localhost:19092", "Redpanda seed brokers")
	reportPath := flag.String("report", "loadtest-report.json", "where to write the final report")
	baselinePath := flag.String("baseline", "", "if set, compare the result against this baseline file and exit non-zero on a >10% regression")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	report, err := loadtest.Run(ctx, loadtest.Config{
		Brokers:     *brokers,
		TargetEPS:   *eps,
		Duration:    *duration,
		WorkerCount: *workers,
		MatchEveryN: *matchEveryN,
		Log:         log,
	})
	if err != nil {
		log.Error("load test run failed", "err", err)
		os.Exit(1)
	}

	log.Info("load test complete",
		"produced", report.Produced, "achieved_eps", report.AchievedEPS,
		"p50_ms", report.LatencyP50Ms, "p95_ms", report.LatencyP95Ms, "p99_ms", report.LatencyP99Ms,
		"signals_expected", report.SignalsExpected, "signals_received", report.SignalsReceived,
		"goroutines_start", report.GoroutinesStart, "goroutines_end", report.GoroutinesEnd, "goroutines_peak", report.GoroutinesPeak,
		"heap_alloc_peak_mb", report.HeapAllocPeakMB,
	)

	if err := loadtest.WriteReport(*reportPath, report); err != nil {
		log.Error("writing report", "err", err)
		os.Exit(1)
	}

	exitCode := 0
	for _, v := range loadtest.CheckAbsoluteThresholds(report) {
		log.Error("absolute threshold violated", "violation", v.String())
		exitCode = 1
	}
	if *baselinePath != "" {
		baseline, err := loadtest.LoadBaseline(*baselinePath)
		if err != nil {
			log.Error("loading baseline", "err", err)
			os.Exit(1)
		}
		for _, v := range loadtest.CompareToBaseline(report, baseline) {
			log.Error("regression beyond 10% of baseline", "violation", v.String())
			exitCode = 1
		}
	}
	os.Exit(exitCode)
}
