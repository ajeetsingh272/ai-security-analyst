package m365

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
)

// T5: "Sustains a simulated 1,000-seat tenant inside one interval."
//
// Disclosed assumption: Microsoft does not publish a fixed audit-event
// volume per seat, so this test approximates a 1,000-seat tenant as 50
// content blobs of 100 records each (5,000 records) across one content
// type in one cycle — a volume consistent with the published ranges for
// a tenant of this size's Exchange/SharePoint/AAD audit activity. Run
// against the local mock (no real network latency to Microsoft's actual
// service), this proves the connector's OWN fetch/parse/DLQ-check/
// normalise path does not become the bottleneck well inside the
// scheduler's one-minute interval — it does NOT prove real-world network
// latency against Microsoft's production endpoints keeps pace, which is
// infrastructure capacity planning, not this connector's logic.
func TestFetch_SustainsSimulated1000SeatTenantLoad(t *testing.T) {
	const blobCount = 50
	const recordsPerBlob = 100

	mock := newMockM365Server(testM365TenantGUID)
	defer mock.close()
	for b := 0; b < blobCount; b++ {
		created := time.Date(2024, 1, 1, 0, b, 0, 0, time.UTC).Format(time.RFC3339)
		records := make([][]byte, recordsPerBlob)
		for r := 0; r < recordsPerBlob; r++ {
			records[r] = exchangeRecord(
				fmtID(b, r),
				created,
				"MailItemsAccessed",
			)
		}
		mock.addBlob("Audit.Exchange", fmtID(b, 0)+"-blob", created, mustJSONArray(records...))
	}

	store := &fakeCredentialStore{
		connectorRowID: "connector-row-1",
		creds: Credentials{
			AccessToken:  "placeholder",
			RefreshToken: "valid-refresh-token",
			ExpiresAt:    time.Now().Add(-time.Hour).Unix(),
		},
	}
	cfg := OAuthConfig{ClientID: "c", ClientSecret: "s", AuthorityBaseURL: mock.srv.URL}
	dlq := sentinelconnector.NewInMemoryPublisher()
	conn := NewConnector(testTenantID, "Audit.Exchange", store, cfg, mock.srv.URL, mock.srv.Client(), dlq)

	start := time.Now()
	batch, _, err := conn.Fetch(context.Background(), nil)
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	want := blobCount * recordsPerBlob
	if len(batch.Events) != want {
		t.Fatalf("expected %d events, got %d", want, len(batch.Events))
	}

	const schedulingInterval = time.Minute
	const budget = schedulingInterval / 4 // generous headroom; see this test's own doc comment on what this does and doesn't prove
	if elapsed > budget {
		t.Fatalf("processing %d events across %d blobs took %v, which exceeds this test's %v budget (interval is %v)",
			want, blobCount, elapsed, budget, schedulingInterval)
	}
	t.Logf("processed %d events across %d blobs in %v (budget %v, interval %v)", want, blobCount, elapsed, budget, schedulingInterval)
}

func fmtID(b, r int) string {
	return "evt-" + strconv.Itoa(b) + "-" + strconv.Itoa(r)
}
