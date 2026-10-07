// Command backfill-reduction is P3-06's own AC4: "the metric is
// backfillable from historical data for trend analysis." It computes
// sentinel.daily_reduction for a range of already-completed calendar
// days, for one tenant or every tenant, reusing exactly the same
// services/correlate/internal/reduction.Store.ComputeDaily the live
// service's own daily sweep calls — a backfill is not a second,
// drifting implementation of the same math, just a historical range of
// calls to the real one. Safe to re-run over an already-backfilled
// range: ComputeDaily deletes any existing row for a (tenant, day)
// before inserting the freshly computed one.
//
// Usage:
//
//	go run ./cmd/backfill-reduction -from=2026-01-01 -to=2026-01-31
//	go run ./cmd/backfill-reduction -from=2026-01-01 -to=2026-01-31 -tenant=<uuid>
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/services/correlate/internal/reduction"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	fromFlag := flag.String("from", "", "first day to backfill, YYYY-MM-DD (inclusive)")
	toFlag := flag.String("to", "", "last day to backfill, YYYY-MM-DD (inclusive)")
	tenantFlag := flag.String("tenant", "", "backfill only this tenant id; default is every tenant")
	flag.Parse()

	from, to, err := parseRange(*fromFlag, *toFlag)
	if err != nil {
		log.Error("parsing -from/-to", "err", err)
		os.Exit(1)
	}

	ctx := context.Background()
	pgPool, err := sentineldb.NewPool(ctx)
	if err != nil {
		log.Error("connecting to postgres", "err", err)
		os.Exit(1)
	}
	defer pgPool.Close()

	chConn, err := clickhouse.Open(&clickhouse.Options{
		Addr: []string{envOr("CLICKHOUSE_ADDR", "localhost:9000")},
		Auth: clickhouse.Auth{
			Database: envOr("CLICKHOUSE_DATABASE", "sentinel"),
			Username: envOr("CLICKHOUSE_USER", "default"),
			Password: envOr("CLICKHOUSE_PASSWORD", ""),
		},
	})
	if err != nil {
		log.Error("connecting to clickhouse", "err", err)
		os.Exit(1)
	}
	defer chConn.Close()

	store := reduction.NewStore(pgPool, chConn)

	tenantIDs := []string{*tenantFlag}
	if *tenantFlag == "" {
		tenantIDs, err = store.AllTenantIDs(ctx)
		if err != nil {
			log.Error("listing tenants", "err", err)
			os.Exit(1)
		}
	}

	failures := 0
	for day := from; !day.After(to); day = day.Add(24 * time.Hour) {
		for _, tenantID := range tenantIDs {
			result, err := store.ComputeDaily(ctx, tenantID, day)
			if err != nil {
				log.Error("backfilling day", "tenant_id", tenantID, "day", day.Format("2006-01-02"), "err", err)
				failures++
				continue
			}
			log.Info("backfilled day", "tenant_id", tenantID, "day", day.Format("2006-01-02"),
				"signals", result.Signals, "cases_escalated", result.CasesEscalated, "ratio", result.Ratio, "ok", result.OK)
		}
	}

	if failures > 0 {
		log.Error("backfill completed with failures", "count", failures)
		os.Exit(1)
	}
	log.Info("backfill complete")
}

func parseRange(fromStr, toStr string) (from, to time.Time, err error) {
	if fromStr == "" || toStr == "" {
		return time.Time{}, time.Time{}, fmt.Errorf("both -from and -to are required")
	}
	from, err = time.Parse("2006-01-02", fromStr)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("parsing -from: %w", err)
	}
	to, err = time.Parse("2006-01-02", toStr)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("parsing -to: %w", err)
	}
	if to.Before(from) {
		return time.Time{}, time.Time{}, fmt.Errorf("-to (%s) is before -from (%s)", toStr, fromStr)
	}
	return from.UTC(), to.UTC(), nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
