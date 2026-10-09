// P7-04 T3: "A single tenant at 10k EPS does not increase other tenants'
// lag." Deliberately a SEPARATE function from Run (harness.go), not a
// new Config field on it — Run measures ONE tenant's own throughput/
// latency; this measures whether ONE tenant's load bleeds into a
// SECOND, unrelated tenant's own latency, which needs two independently
// tracked tenants and a real ShardController driving the hot one's
// actual key routing, neither of which Run's own single-tenant shape
// was built for.
//
// The mechanism being proven: a worker instance's own EachRecord
// callback (services/detect/internal/worker's Run loop) processes every
// partition it owns SEQUENTIALLY within one poll — a hot tenant
// concentrated onto a single partition that a worker also owns a quiet
// tenant's partition on can delay that quiet tenant's own records
// simply by taking longer to get through its own backlog first. Sharding
// the hot tenant (go/sentinelstream.ShardController, wired identically
// to how services/ingest/cmd/ingest/main.go wires it in production)
// spreads its load across more partitions/workers, so no single worker
// absorbs all of it.
package loadtest

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelsignal"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/worker"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
)

// NoisyNeighborConfig mirrors Config's own withDefaults convention.
type NoisyNeighborConfig struct {
	Brokers string
	Pool    *pgxpool.Pool // required — ShardController needs a real tenants.eps_quota row to shard against
	// HotTenantEPS is the flooding tenant's own target rate (10,000 for
	// the ticket's literal AC; CI's own gate test uses less — see
	// noisy_neighbor_integration_test.go's own comment for why, mirroring
	// harness_integration_test.go's identical reduced-scale convention).
	HotTenantEPS int
	// QuietTenantEPS is deliberately small and steady — a tenant that
	// was never hot before the flood and should not become so during it.
	QuietTenantEPS int
	Duration       time.Duration
	WorkerCount    int
	MatchEveryN    int
	DrainGrace     time.Duration
	Warmup         time.Duration
}

func (c NoisyNeighborConfig) withDefaults() NoisyNeighborConfig {
	if c.WorkerCount == 0 {
		c.WorkerCount = 4
	}
	if c.MatchEveryN == 0 {
		c.MatchEveryN = 50
	}
	if c.DrainGrace == 0 {
		c.DrainGrace = 15 * time.Second
	}
	if c.Warmup == 0 {
		c.Warmup = 3 * time.Second
	}
	return c
}

// NoisyNeighborReport reports each tenant's own latency distribution
// separately — the whole point is comparing them, not a combined number.
type NoisyNeighborReport struct {
	HotTenantAchievedEPS   float64 `json:"hot_tenant_achieved_eps"`
	HotTenantP99Ms         float64 `json:"hot_tenant_p99_ms"`
	QuietTenantAchievedEPS float64 `json:"quiet_tenant_achieved_eps"`
	QuietTenantP50Ms       float64 `json:"quiet_tenant_p50_ms"`
	QuietTenantP99Ms       float64 `json:"quiet_tenant_p99_ms"`
	HotTenantFinalShards   int     `json:"hot_tenant_final_shards"`
}

// RunNoisyNeighborCheck floods one real tenant (sharded, via a real
// ShardController reading a real low eps_quota) while a second, quiet
// tenant publishes steadily through the SAME worker pool/consumer group
// — both through real sentinelstream.RedpandaPublisher instances, the
// identical production path services/ingest actually uses, not a
// synthetic shortcut.
func RunNoisyNeighborCheck(ctx context.Context, cfg NoisyNeighborConfig) (NoisyNeighborReport, error) {
	cfg = cfg.withDefaults()

	tree, err := buildTree()
	if err != nil {
		return NoisyNeighborReport{}, err
	}

	runID := fmt.Sprintf("noisyneighbor-%d", time.Now().UnixNano())
	group := "noisyneighbor-" + runID
	// tenants.id is a real uuid column — a human-readable suffix would
	// fail the insert outright (confirmed against the live schema, not
	// assumed), so these are real UUIDs; runID itself stays a plain
	// string, used only for the consumer group name.
	hotTenantID := uuid.New().String()
	quietTenantID := uuid.New().String()

	// Seed a real tenant row with a deliberately tiny eps_quota so the
	// REAL ShardController (not a test seam) decides to shard almost
	// immediately once flooded — the actual production decision path,
	// exercised for real.
	if _, err := cfg.Pool.Exec(ctx, `INSERT INTO tenants (id, name, plan, eps_quota) VALUES ($1, $2, 'trial', 50)`, hotTenantID, "noisy-neighbor hot probe"); err != nil {
		return NoisyNeighborReport{}, fmt.Errorf("loadtest: seeding hot tenant: %w", err)
	}
	defer cfg.Pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, hotTenantID)

	shardController := sentinelstream.NewShardController(cfg.Pool)
	defer shardController.Close()

	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	for i := 0; i < cfg.WorkerCount; i++ {
		consumer, err := kgo.NewClient(
			kgo.SeedBrokers(cfg.Brokers),
			kgo.ConsumeTopics(sentinelstream.EventsNormalized),
			kgo.ConsumerGroup(group),
			kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
			kgo.DisableAutoCommit(),
		)
		if err != nil {
			return NoisyNeighborReport{}, fmt.Errorf("loadtest: creating consumer %d: %w", i, err)
		}
		producer, err := kgo.NewClient(kgo.SeedBrokers(cfg.Brokers))
		if err != nil {
			return NoisyNeighborReport{}, fmt.Errorf("loadtest: creating producer %d: %w", i, err)
		}
		w := worker.New(tree, consumer, producer, worker.Options{Group: group})
		defer producer.Close()
		defer consumer.Close()
		go func() { _ = w.Run(runCtx) }()
	}

	time.Sleep(cfg.Warmup)

	var hotProduceTimes, quietProduceTimes sync.Map
	var hotProduced, quietProduced atomic.Int64

	produceCtx, cancelProduce := context.WithTimeout(context.Background(), cfg.Duration)
	defer cancelProduce()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		produceNoisyNeighborLoad(produceCtx, cfg.Brokers, hotTenantID, cfg.HotTenantEPS, cfg.MatchEveryN, shardController, &hotProduceTimes, &hotProduced)
	}()
	go func() {
		defer wg.Done()
		produceNoisyNeighborLoad(produceCtx, cfg.Brokers, quietTenantID, cfg.QuietTenantEPS, cfg.MatchEveryN, nil, &quietProduceTimes, &quietProduced)
	}()

	startedAt := time.Now()
	wg.Wait()
	produceElapsed := time.Since(startedAt)

	var latMu sync.Mutex
	var hotLatencies, quietLatencies []float64
	collectCtx, cancelCollect := context.WithTimeout(context.Background(), cfg.Duration+cfg.DrainGrace+cfg.Warmup)
	defer cancelCollect()
	collectNoisyNeighborSignals(collectCtx, cfg.Brokers, runID, hotTenantID, quietTenantID, &hotProduceTimes, &quietProduceTimes, &latMu, &hotLatencies, &quietLatencies)

	cancelRun()

	s := shardController.StateSnapshot(hotTenantID)

	latMu.Lock()
	sort.Float64s(hotLatencies)
	sort.Float64s(quietLatencies)
	report := NoisyNeighborReport{
		HotTenantAchievedEPS:   float64(hotProduced.Load()) / produceElapsed.Seconds(),
		HotTenantP99Ms:         percentile(hotLatencies, 0.99),
		QuietTenantAchievedEPS: float64(quietProduced.Load()) / produceElapsed.Seconds(),
		QuietTenantP50Ms:       percentile(quietLatencies, 0.50),
		QuietTenantP99Ms:       percentile(quietLatencies, 0.99),
		HotTenantFinalShards:   s,
	}
	latMu.Unlock()
	return report, nil
}

func produceNoisyNeighborLoad(ctx context.Context, brokers, tenantID string, targetEPS, matchEveryN int, sc *sentinelstream.ShardController, produceTimes *sync.Map, produced *atomic.Int64) {
	producer, err := kgo.NewClient(kgo.SeedBrokers(brokers))
	if err != nil {
		return
	}
	defer producer.Close()

	const batchSize = 50
	secondsPerBatch := float64(batchSize) / float64(targetEPS)
	batchInterval := time.Duration(secondsPerBatch * float64(time.Second))

	var idx int64
	var wg sync.WaitGroup
	for ctx.Err() == nil {
		batchStart := time.Now()
		for i := 0; i < batchSize; i++ {
			n := idx
			idx++
			eventID := fmt.Sprintf("%s-%d", tenantID, n)
			operation := "Send"
			if n%int64(matchEveryN) == 0 {
				operation = "New-InboxRule"
				produceTimes.Store(eventID, time.Now())
			}
			payload, err := json.Marshal(wireEventJSON{
				TenantID: tenantID, EventID: eventID,
				ClassUID: 3005, ActivityID: 1, SeverityID: 1,
				Metadata: map[string]string{"product": "m365", "operation": operation},
			})
			if err != nil {
				continue
			}
			key := sentinelstream.TenantKey(tenantID)
			if sc != nil {
				key = sc.KeyFor(ctx, tenantID)
			}
			wg.Add(1)
			producer.Produce(context.Background(), &kgo.Record{
				Topic: sentinelstream.EventsNormalized,
				Key:   []byte(key),
				Value: payload,
			}, func(_ *kgo.Record, err error) {
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
}

func collectNoisyNeighborSignals(
	ctx context.Context, brokers, runID, hotTenantID, quietTenantID string,
	hotProduceTimes, quietProduceTimes *sync.Map,
	latMu *sync.Mutex, hotLatencies, quietLatencies *[]float64,
) {
	group := "noisyneighbor-collect-" + runID
	client, err := kgo.NewClient(
		kgo.SeedBrokers(brokers),
		kgo.ConsumeTopics(sentinelstream.Signals),
		kgo.ConsumerGroup(group),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
	)
	if err != nil {
		return
	}
	defer client.Close()

	for ctx.Err() == nil {
		pollCtx, cancel := context.WithTimeout(ctx, 1*time.Second)
		fetches := client.PollFetches(pollCtx)
		cancel()
		fetches.EachRecord(func(r *kgo.Record) {
			var sig sentinelsignal.Signal
			if err := json.Unmarshal(r.Value, &sig); err != nil || sig.RuleID != newInboxForwardingRuleID || len(sig.EventIDs) == 0 {
				return
			}
			var times *sync.Map
			var bucket *[]float64
			switch sig.TenantID {
			case hotTenantID:
				times, bucket = hotProduceTimes, hotLatencies
			case quietTenantID:
				times, bucket = quietProduceTimes, quietLatencies
			default:
				return
			}
			raw, ok := times.LoadAndDelete(sig.EventIDs[0])
			if !ok {
				return
			}
			latencyMs := sig.DetectedAt.Sub(raw.(time.Time)).Seconds() * 1000
			latMu.Lock()
			*bucket = append(*bucket, latencyMs)
			latMu.Unlock()
		})
	}
}
