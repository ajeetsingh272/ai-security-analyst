package m365

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
)

// fakeCredentialStore is an in-memory credentialStorer — T1/T2/T4/T5 are
// about Connector's own fetch/cursor/DLQ logic, not CredentialStore's
// Postgres persistence (that is proven separately, against real Postgres,
// in credentials_integration_test.go).
type fakeCredentialStore struct {
	creds          Credentials
	connectorRowID string
	saveCount      int
}

func (f *fakeCredentialStore) Load(_ context.Context, _ string) (string, Credentials, error) {
	return f.connectorRowID, f.creds, nil
}

func (f *fakeCredentialStore) Save(_ context.Context, _, _ string, creds Credentials) error {
	f.creds = creds
	f.saveCount++
	return nil
}

const testTenantID = "11111111-1111-4111-8111-111111111111"
const testM365TenantGUID = "22222222-2222-4222-8222-222222222222"

func newTestConnector(t *testing.T, mock *mockM365Server, dlq sentinelconnector.Publisher) *Connector {
	t.Helper()
	store := &fakeCredentialStore{
		connectorRowID: "connector-row-1",
		creds: Credentials{
			// Deliberately already expired: the only source this package
			// has for the Azure AD tenant GUID is the "tid" claim inside a
			// REAL access token (see m365TenantIDFromAccessToken's doc
			// comment) — an already-expired starting token forces an
			// immediate refresh against the mock server, which issues a
			// proper fakeJWT carrying that claim, exactly as a genuine
			// Microsoft response would.
			AccessToken:  "placeholder-pre-refresh-token",
			RefreshToken: "valid-refresh-token",
			ExpiresAt:    time.Now().Add(-time.Hour).Unix(),
			Scope:        "https://manage.office.com/ActivityFeed.Read",
		},
	}
	cfg := OAuthConfig{ClientID: "test-client", ClientSecret: "test-secret", AuthorityBaseURL: mock.srv.URL}
	return NewConnector(testTenantID, "Audit.Exchange", store, cfg, mock.srv.URL, mock.srv.Client(), dlq)
}

func exchangeRecord(id, creationTime, operation string) []byte {
	b, _ := json.Marshal(map[string]string{"Id": id, "CreationTime": creationTime, "Operation": operation})
	return b
}

// T1: "Recorded API fixtures produce the expected set of raw events" —
// against the mock server's documented-contract responses, exactly the
// gap P1-02's own T1 disclosed (everything proven except a real Microsoft
// tenant).
func TestFetch_ProducesExpectedRawEvents(t *testing.T) {
	mock := newMockM365Server(testM365TenantGUID)
	defer mock.close()
	mock.addBlob("Audit.Exchange", "blob-1", "2024-01-01T00:00:00Z",
		mustJSONArray(exchangeRecord("evt-1", "2024-01-01T00:00:00Z", "MailItemsAccessed"), exchangeRecord("evt-2", "2024-01-01T00:00:01Z", "Send")))
	mock.addBlob("Audit.Exchange", "blob-2", "2024-01-01T00:05:00Z",
		mustJSONArray(exchangeRecord("evt-3", "2024-01-01T00:05:00Z", "MailItemsAccessed")))

	dlq := sentinelconnector.NewInMemoryPublisher()
	conn := newTestConnector(t, mock, dlq)

	batch, nextCur, err := conn.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(batch.Events) != 3 {
		t.Fatalf("expected 3 raw events, got %d", len(batch.Events))
	}
	var ids []string
	for _, ev := range batch.Events {
		var rec struct{ Id string }
		if err := json.Unmarshal(ev.Payload, &rec); err != nil {
			t.Fatalf("unmarshalling event payload: %v", err)
		}
		ids = append(ids, rec.Id)
	}
	want := []string{"evt-1", "evt-2", "evt-3"}
	for i, id := range want {
		if ids[i] != id {
			t.Fatalf("event %d: got id %q, want %q (full order: %v)", i, ids[i], id, ids)
		}
	}

	var state cursorState
	if err := json.Unmarshal(nextCur, &state); err != nil {
		t.Fatalf("decoding next cursor: %v", err)
	}
	if state.LastContentID != "blob-2" {
		t.Fatalf("expected cursor to checkpoint at blob-2, got %q", state.LastContentID)
	}
}

// T2: "Restart mid-batch resumes without loss or observable duplication."
// Simulated by calling Fetch twice with a brand new Connector instance the
// second time (a fresh process, as a real restart would be) but the SAME
// cursor the first call returned — exactly what the scheduler's own crash
// recovery path does (ADR-0010).
func TestFetch_RestartResumesWithoutLossOrDuplication(t *testing.T) {
	mock := newMockM365Server(testM365TenantGUID)
	defer mock.close()
	mock.addBlob("Audit.Exchange", "blob-1", "2024-01-01T00:00:00Z", mustJSONArray(exchangeRecord("evt-1", "2024-01-01T00:00:00Z", "Send")))
	mock.addBlob("Audit.Exchange", "blob-2", "2024-01-01T00:05:00Z", mustJSONArray(exchangeRecord("evt-2", "2024-01-01T00:05:00Z", "Send")))

	dlq := sentinelconnector.NewInMemoryPublisher()
	conn1 := newTestConnector(t, mock, dlq)
	batch1, cur1, err := conn1.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("first Fetch: %v", err)
	}
	if len(batch1.Events) != 2 {
		t.Fatalf("expected 2 events on first fetch, got %d", len(batch1.Events))
	}

	// A new blob arrives before the "restart".
	mock.addBlob("Audit.Exchange", "blob-3", "2024-01-01T00:10:00Z", mustJSONArray(exchangeRecord("evt-3", "2024-01-01T00:10:00Z", "Send")))

	// Brand new Connector — a different in-process instance, same as a
	// genuinely restarted process would construct — given the SAME
	// committed cursor.
	conn2 := newTestConnector(t, mock, dlq)
	batch2, _, err := conn2.Fetch(context.Background(), cur1)
	if err != nil {
		t.Fatalf("second Fetch (post-restart): %v", err)
	}
	if len(batch2.Events) != 1 {
		t.Fatalf("expected exactly 1 NEW event after restart (blob-1/blob-2 must not reappear), got %d", len(batch2.Events))
	}
	var rec struct{ Id string }
	_ = json.Unmarshal(batch2.Events[0].Payload, &rec)
	if rec.Id != "evt-3" {
		t.Fatalf("expected only evt-3 after restart, got %q", rec.Id)
	}
}

// T4: "Malformed blob routes to DLQ with raw content intact." The cursor
// still advances past it (AC3's "never dropped" means preserved in the
// DLQ, not retried forever) and a well-formed blob listed alongside it is
// still processed normally in the same cycle.
func TestFetch_MalformedBlobRoutesToDLQWithRawContentIntact(t *testing.T) {
	mock := newMockM365Server(testM365TenantGUID)
	defer mock.close()
	malformedBody := []byte(`{not valid json at all`)
	mock.addBlob("Audit.Exchange", "blob-bad", "2024-01-01T00:00:00Z", malformedBody)
	mock.addBlob("Audit.Exchange", "blob-good", "2024-01-01T00:05:00Z", mustJSONArray(exchangeRecord("evt-good", "2024-01-01T00:05:00Z", "Send")))

	dlq := sentinelconnector.NewInMemoryPublisher()
	conn := newTestConnector(t, mock, dlq)

	batch, nextCur, err := conn.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(batch.Events) != 1 {
		t.Fatalf("expected 1 good event despite the malformed blob, got %d", len(batch.Events))
	}

	dlqd := dlq.Published(testTenantID)
	if len(dlqd) != 1 {
		t.Fatalf("expected exactly 1 dead-lettered message, got %d", len(dlqd))
	}
	var env deadLetterEnvelope
	if err := json.Unmarshal(dlqd[0].Payload, &env); err != nil {
		t.Fatalf("unmarshalling dead-letter envelope: %v", err)
	}
	if string(env.RawContent) != string(malformedBody) {
		t.Fatalf("dead-lettered raw content does not match the original bytes:\n got: %s\nwant: %s", env.RawContent, malformedBody)
	}
	if env.ContentID != "blob-bad" {
		t.Fatalf("expected the dead letter to identify blob-bad, got %q", env.ContentID)
	}

	var state cursorState
	_ = json.Unmarshal(nextCur, &state)
	if state.LastContentID != "blob-good" {
		t.Fatalf("expected the cursor to advance past the malformed blob to blob-good, got %q", state.LastContentID)
	}
}

// A revoked refresh token surfaces Fetch's error as ErrConsentRevoked
// (wrapped), the same mapping P1-02's own ticket (T4) establishes for the
// OAuth client itself — proven here at the connector level, where the
// scheduler actually observes it (healthStatusFor).
func TestFetch_RevokedConsentSurfacesAsErrConsentRevoked(t *testing.T) {
	mock := newMockM365Server(testM365TenantGUID)
	defer mock.close()
	mock.revokedRefreshTok = "a-revoked-refresh-token"

	store := &fakeCredentialStore{
		connectorRowID: "connector-row-1",
		creds: Credentials{
			AccessToken:  "expired-access-token",
			RefreshToken: "a-revoked-refresh-token",
			ExpiresAt:    time.Now().Add(-time.Hour).Unix(), // already expired, forces a refresh
		},
	}
	cfg := OAuthConfig{ClientID: "c", ClientSecret: "s", AuthorityBaseURL: mock.srv.URL}
	conn := NewConnector(testTenantID, "Audit.Exchange", store, cfg, mock.srv.URL, mock.srv.Client(), sentinelconnector.NewInMemoryPublisher())

	_, _, err := conn.Fetch(context.Background(), nil)
	if err == nil {
		t.Fatal("expected Fetch to fail when the refresh token has been revoked")
	}
	if !errors.Is(err, sentinelconnector.ErrConsentRevoked) {
		t.Fatalf("expected the error to wrap ErrConsentRevoked, got: %v", err)
	}
}

// listAvailableContent must follow every NextPageUri page Microsoft's API
// returns (content.go's own doc comment) — proven here with a mock forced
// to paginate (pageSize=2 against 5 blobs, so the connector must follow 3
// pages to see all of them).
func TestFetch_FollowsNextPageUriAcrossMultiplePages(t *testing.T) {
	mock := newMockM365Server(testM365TenantGUID)
	defer mock.close()
	mock.pageSize = 2
	for i := 0; i < 5; i++ {
		created := time.Date(2024, 1, 1, 0, i, 0, 0, time.UTC).Format(time.RFC3339)
		mock.addBlob("Audit.Exchange", "blob-"+string(rune('a'+i)), created, mustJSONArray(exchangeRecord("evt-"+string(rune('a'+i)), created, "Send")))
	}

	dlq := sentinelconnector.NewInMemoryPublisher()
	conn := newTestConnector(t, mock, dlq)

	batch, _, err := conn.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(batch.Events) != 5 {
		t.Fatalf("expected all 5 events across 3 pages (pageSize=2), got %d", len(batch.Events))
	}
}

func mustJSONArray(records ...[]byte) []byte {
	out := []byte("[")
	for i, r := range records {
		if i > 0 {
			out = append(out, ',')
		}
		out = append(out, r...)
	}
	out = append(out, ']')
	return out
}
