package sentinelconnector

import (
	"context"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// T2: lag calculation is correct when a connector has produced no events at
// all — hasSucceeded=false must measure from registeredAt, a real, growing
// duration, not zero. A connector that has NEVER worked must not look
// identical to one that just succeeded a moment ago.
func TestComputeLagMeasuresFromRegistrationWhenNeverSucceeded(t *testing.T) {
	registeredAt := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	now := registeredAt.Add(90 * time.Minute)

	lag := computeLag(now, registeredAt, time.Time{}, false)
	if lag != 90*time.Minute {
		t.Fatalf("expected lag=90m measured from registeredAt, got %v", lag)
	}
}

func TestComputeLagMeasuresFromLastSuccessOnceItHasSucceeded(t *testing.T) {
	registeredAt := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) // long ago — must be ignored once hasSucceeded is true
	lastSuccess := time.Date(2026, 1, 1, 11, 55, 0, 0, time.UTC)
	now := lastSuccess.Add(5 * time.Minute)

	lag := computeLag(now, registeredAt, lastSuccess, true)
	if lag != 5*time.Minute {
		t.Fatalf("expected lag=5m measured from lastSuccess (not registeredAt), got %v", lag)
	}
}

// TestIngestLagGaugeIncreasesForAStalledConnector proves the actual wiring,
// not just the pure function: a connector whose Fetch never returns is
// still periodically re-measured by runLagReporter, and the OTel gauge
// value genuinely increases cycle over cycle — read back through a real
// sdk/metric ManualReader (no mock, no fake Recorder), the same mechanism
// a real OTLP exporter would use. The clock is injected so this proves
// minutes of simulated elapsed time without a real wall-clock wait.
func TestIngestLagGaugeIncreasesForAStalledConnector(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	meter := mp.Meter("test")
	ingestLag, err := meter.Int64Gauge("connector.ingest_lag_seconds")
	if err != nil {
		t.Fatalf("creating gauge: %v", err)
	}

	tenantID := "tenant-stalled"
	connID := "conn-stalled"
	stalled := &blockingForeverConnector{id: "stalled"}

	s := NewScheduler(NewInMemoryPublisher(), NewInMemoryCursorStore(), SchedulerOptions{
		IngestLag:         ingestLag,
		LagReportInterval: time.Hour, // irrelevant here — reportLag is called directly, not via the ticker
	})

	fakeNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return fakeNow }

	s.Register(TenantConnector{TenantID: tenantID, ConnectorRowID: connID, Stream: "main", Connector: stalled})

	readGauge := func() int64 {
		var data metricdata.ResourceMetrics
		if err := reader.Collect(context.Background(), &data); err != nil {
			t.Fatalf("collecting metrics: %v", err)
		}
		for _, sm := range data.ScopeMetrics {
			for _, m := range sm.Metrics {
				if m.Name != "connector.ingest_lag_seconds" {
					continue
				}
				g, ok := m.Data.(metricdata.Gauge[int64])
				if !ok || len(g.DataPoints) == 0 {
					t.Fatalf("expected at least one int64 gauge data point for %s", m.Name)
				}
				return g.DataPoints[len(g.DataPoints)-1].Value
			}
		}
		t.Fatal("connector.ingest_lag_seconds metric not found")
		return 0
	}

	s.reportLag(context.Background())
	first := readGauge()
	if first != 0 {
		t.Fatalf("expected 0s lag immediately at registration, got %ds", first)
	}

	fakeNow = fakeNow.Add(7 * time.Minute)
	s.reportLag(context.Background())
	second := readGauge()
	wantSeconds := int64((7 * time.Minute).Seconds())
	if second != wantSeconds {
		t.Fatalf("expected lag=%ds after 7 simulated minutes with no successful cycle, got %ds", wantSeconds, second)
	}
	if second <= first {
		t.Fatalf("expected the gauge to have increased (%ds -> %ds) for a connector that never succeeds", first, second)
	}
}

// blockingForeverConnector's Fetch never returns on its own — it only
// returns when ctx is cancelled — simulating a genuinely stalled connector
// for the gauge-wiring test above. Unlike scheduler_concurrency_test.go's
// blockingConnector, nothing in this test ever closes an unblock channel;
// the stall is permanent by construction.
type blockingForeverConnector struct {
	id ConnectorID
}

func (c *blockingForeverConnector) ID() ConnectorID { return c.id }

func (c *blockingForeverConnector) Fetch(ctx context.Context, _ Cursor) (Batch, Cursor, error) {
	<-ctx.Done()
	return Batch{}, nil, ctx.Err()
}

func (c *blockingForeverConnector) Normalise(RawEvent) ([]ocsf.Event, error) { return nil, nil }

func (c *blockingForeverConnector) HealthCheck(context.Context) error { return nil }
