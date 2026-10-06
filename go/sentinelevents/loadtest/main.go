// Command loadtest is P1-07 T3: sustain 30k events/sec and observe the
// ClickHouse merge queue depth stays stable.
//
// A SEPARATE, opt-in program, not something `go test` runs automatically —
// a 15-minute sustained run has no business being part of a routine test
// suite. Run explicitly:
//
//	go run ./loadtest -rate=30000 -duration=15m
//
// Rate-limited by design, never a burst: P1-06's commit message documents
// a real incident where an unbounded bulk generation crashed the whole
// Docker host. This tool paces production to the target rate instead of
// firing everything as fast as possible, and the consumer side writes
// through the SAME bounded Consumer/Writer this package ships for
// production use — batches are capped at a fixed row count, so memory use
// here is bounded by construction regardless of how long the run lasts.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelevents"
	"github.com/twmb/franz-go/pkg/kgo"
)

func main() {
	rate := flag.Int("rate", 30000, "target events per second")
	duration := flag.Duration("duration", 15*time.Minute, "how long to sustain the rate")
	tenantCount := flag.Int("tenants", 20, "number of distinct synthetic tenants to spread load across")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	produceClient, err := kgo.NewClient(kgo.SeedBrokers("localhost:19092"))
	if err != nil {
		log.Error("creating producer client", "err", err)
		os.Exit(1)
	}
	defer produceClient.Close()

	writer, err := sentinelevents.NewClickHouseWriter("localhost:9000", "sentinel", "default", "")
	if err != nil {
		log.Error("connecting to ClickHouse", "err", err)
		os.Exit(1)
	}
	defer writer.Close()

	consumeClient, err := kgo.NewClient(
		kgo.SeedBrokers("localhost:19092"),
		kgo.ConsumeTopics("events.normalized"),
		kgo.ConsumerGroup("loadtest-"+fmt.Sprint(time.Now().Unix())),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtEnd()), // only this run's own traffic
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		log.Error("creating consumer client", "err", err)
		os.Exit(1)
	}
	defer consumeClient.Close()

	var written atomic.Int64
	consumer := sentinelevents.NewConsumer(consumeClient, writer, sentinelevents.ConsumerOptions{
		// 10k rows or 2s, whichever first — large enough to keep part
		// counts sane at 30k EPS (one flush roughly every ~0.3s at full
		// rate), small enough that a slow ClickHouse is noticed quickly.
		Trigger: sentinelevents.BatchTrigger{MaxRows: 10000, MaxAge: 2 * time.Second},
		Log:     log,
		OnWrite: func(n int) { written.Add(int64(n)) },
	})
	consumerDone := make(chan struct{})
	go func() {
		defer close(consumerDone)
		if err := consumer.Run(ctx); err != nil && ctx.Err() == nil {
			log.Error("consumer stopped unexpectedly", "err", err)
		}
	}()

	go monitorMergeQueue(ctx, log)

	log.Info("starting load", "target_eps", *rate, "duration", duration.String(), "tenants", *tenantCount)
	runStart := time.Now()
	var produced int64
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	deadline := time.Now().Add(*duration)

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			log.Info("interrupted, stopping early")
			deadline = time.Now()
		case secondStart := <-ticker.C:
			n := produceOneSecond(ctx, produceClient, *rate, *tenantCount, secondStart)
			produced += int64(n)
			log.Info("tick", "produced_this_tick", n, "total_produced", produced, "total_written", written.Load(),
				"elapsed", time.Since(runStart).Round(time.Second).String())
		}
	}

	log.Info("load window finished, draining", "total_produced", produced)
	drainDeadline := time.Now().Add(30 * time.Second)
	for written.Load() < produced && time.Now().Before(drainDeadline) {
		time.Sleep(500 * time.Millisecond)
	}

	ok := written.Load() == produced
	log.Info("load test result", "produced", produced, "written", written.Load(), "ok", ok,
		"effective_eps", float64(produced)/time.Since(runStart).Seconds())

	// Stop the consumer and monitor goroutines, and WAIT for the consumer
	// to actually exit its poll loop, before the deferred client.Close()
	// calls below run — found the hard way: without this wait, Close()
	// could run while Run()'s goroutine was still mid-poll on the same
	// client, flooding "client closed" errors on every subsequent
	// iteration instead of a single clean shutdown log line.
	stop()
	select {
	case <-consumerDone:
	case <-time.After(5 * time.Second):
		log.Error("consumer did not stop within 5s of cancellation")
	}

	if !ok {
		os.Exit(1)
	}
}

// produceOneSecond sends `rate` records spread across `tenantCount`
// synthetic tenants, all within roughly the second starting at `start` —
// pacing, not bursting.
func produceOneSecond(ctx context.Context, client *kgo.Client, rate, tenantCount int, start time.Time) int {
	records := make([]*kgo.Record, rate)
	for i := 0; i < rate; i++ {
		// tenant_id is a UUID column in ClickHouse — a human-readable fake
		// id is rejected by the driver, discovered the hard way: a single
		// malformed row blocked the whole batch forever (see writer.go's
		// now-hardened Write, and the commit message for the full story).
		tenant := fmt.Sprintf("10000000-0000-4000-8000-%012d", i%tenantCount)
		row := sentinelevents.EventRow{
			TenantID: tenant, EventID: fmt.Sprintf("%s-%d-%d", tenant, start.UnixNano(), i),
			Time: time.Now(), ClassUID: 3002, CategoryUID: 3, ActivityID: 1, TypeUID: 300201, SeverityID: 1,
			ActorUserUID: fmt.Sprintf("user-%d", i%500), StatusID: 1, Message: "load test event",
		}
		payload, _ := json.Marshal(row)
		records[i] = &kgo.Record{Topic: "events.normalized", Key: []byte(tenant + ":0"), Value: payload}
	}
	results := client.ProduceSync(ctx, records...)
	ok := 0
	for _, r := range results {
		if r.Err == nil {
			ok++
		}
	}
	return ok
}

// monitorMergeQueue polls ClickHouse's own view of its merge backlog every
// 10s for the run's duration — AC4, "merge queue depth is monitored".
func monitorMergeQueue(ctx context.Context, log *slog.Logger) {
	conn, err := clickhouse.Open(&clickhouse.Options{Addr: []string{"localhost:9000"}, Auth: clickhouse.Auth{Database: "sentinel", Username: "default"}})
	if err != nil {
		log.Error("merge queue monitor: connecting", "err", err)
		return
	}
	defer conn.Close()

	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			var activeParts, activeMerges uint64
			_ = conn.QueryRow(ctx, "SELECT count() FROM system.parts WHERE table = 'events' AND active").Scan(&activeParts)
			_ = conn.QueryRow(ctx, "SELECT count() FROM system.merges WHERE table = 'events'").Scan(&activeMerges)
			log.Info("merge queue", "active_parts", activeParts, "active_merges", activeMerges)
		}
	}
}
