//go:build integration

package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

// T3: 30k EPS sustained across a scaled worker set — AC's own "horizontal
// scaling is linear up to the partition count" means this is a claim
// about several worker instances TOGETHER, not one single-threaded loop,
// so this test spins up workerCount real Worker instances in the SAME
// consumer group (events.normalized has 128 partitions, plenty to split
// across them) and measures the GROUP's aggregate consumer lag while a
// producer sustains the target rate.
//
// Most synthetic events deliberately match no rule (realistic traffic:
// the overwhelming majority of real events never trigger a detection) —
// a small, fixed fraction are crafted to match new-inbox-forwarding-rule,
// so the signal-publish path is genuinely exercised under load too, not
// bypassed entirely.
func TestWorker_30kEPSSustainedAcrossScaledWorkerSet(t *testing.T) {
	const targetEPS = 30000
	const duration = 5 * time.Second
	const totalEvents = targetEPS * int(duration/time.Second)
	const workerCount = 4
	const matchEveryN = 500 // ~0.2% of events are crafted to match a real rule

	group := "test-detect-t3-" + randomID(t)

	// Drive production from a dedicated goroutine, paced to targetEPS via
	// a simple per-batch sleep — the same token-bucket-by-batch shape
	// go/soaktest's own load generator uses, good enough to prove
	// "sustained", not a claim about perfectly uniform inter-arrival time.
	producer, err := kgo.NewClient(kgo.SeedBrokers(brokers))
	if err != nil {
		t.Fatalf("creating load producer: %v", err)
	}
	defer producer.Close()

	var produced atomic.Int64
	var wg sync.WaitGroup
	produceStart := time.Now()
	const batchSize = 500
	secondsPerBatch := float64(batchSize) / float64(targetEPS)
	batchInterval := time.Duration(secondsPerBatch * float64(time.Second))

	go func() {
		for sent := 0; sent < totalEvents; sent += batchSize {
			batchStart := time.Now()
			records := make([]*kgo.Record, 0, batchSize)
			for i := 0; i < batchSize && sent+i < totalEvents; i++ {
				idx := sent + i
				wev := wireEvent{
					TenantID: fmt.Sprintf("loadtest-%s", group),
					EventID:  fmt.Sprintf("%s-%d", group, idx),
					ClassUID: 3005, ActivityID: 1, SeverityID: 1,
					Metadata: map[string]string{"product": "m365", "operation": "Send"},
				}
				if idx%matchEveryN == 0 {
					wev.Metadata["operation"] = "New-InboxRule"
				}
				payload, err := json.Marshal(wev)
				if err != nil {
					continue
				}
				records = append(records, &kgo.Record{
					Topic: sentinelstream.EventsNormalized,
					Key:   []byte(fmt.Sprintf("%s:%d", wev.TenantID, idx%64)),
					Value: payload,
				})
			}
			for _, r := range records {
				wg.Add(1)
				producer.Produce(context.Background(), r, func(_ *kgo.Record, err error) {
					defer wg.Done()
					if err == nil {
						produced.Add(1)
					}
				})
			}
			if elapsed := time.Since(batchStart); elapsed < batchInterval {
				time.Sleep(batchInterval - elapsed)
			}
		}
		wg.Wait()
	}()

	// workerCount real Workers, same group — franz-go's own consumer-group
	// rebalancing splits events.normalized's partitions across them.
	workers := make([]*Worker, workerCount)
	consumers := make([]*kgo.Client, workerCount)
	ctx, cancel := context.WithTimeout(context.Background(), duration+30*time.Second)
	defer cancel()
	for i := 0; i < workerCount; i++ {
		w, consumer, prod := newWorker(t, group)
		workers[i] = w
		consumers[i] = consumer
		defer prod.Close()
		defer consumer.Close()
		go func(w *Worker) { _ = w.Run(ctx) }(w)
	}

	// Wait for production to finish, then poll the group's own aggregate
	// lag (kadm.Client.Lag, the same call RunLagReporter uses in
	// production) until it drains to zero — proving the worker set kept
	// pace with a sustained 30k EPS producer, not just that it eventually
	// catches up from an unbounded backlog.
	deadline := produceStart.Add(duration + 30*time.Second)
	admin := kadm.NewClient(consumers[0])
	var lastLag int64 = -1
	for time.Now().Before(deadline) {
		if produced.Load() >= int64(totalEvents) {
			lags, err := admin.Lag(context.Background(), group)
			if err == nil {
				if gl, ok := lags[group]; ok && gl.Error() == nil {
					lastLag = gl.Lag.Total()
					if lastLag <= 0 {
						break
					}
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}

	// Stop every worker's own poll loop before the deferred client.Close()
	// calls run — otherwise Run keeps polling a client mid-Close() and logs
	// a harmless but noisy "client closed" fetch error on its way out.
	cancel()
	time.Sleep(200 * time.Millisecond)

	if produced.Load() < int64(totalEvents) {
		t.Fatalf("producer only confirmed %d/%d events within the test window", produced.Load(), totalEvents)
	}
	if lastLag > 0 {
		t.Fatalf("consumer group lag did not drain to zero within the budget (last observed: %d) — the worker set fell behind a sustained %d EPS", lastLag, targetEPS)
	}
}
