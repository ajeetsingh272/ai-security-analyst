package google

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
)

// fakeCredentialStore mirrors m365's own — T1/T2/T4 here are about this
// package's fetch/cursor/DLQ logic, not CredentialStore's Postgres
// persistence (proven separately in credentials_integration_test.go).
type fakeCredentialStore struct {
	creds          Credentials
	connectorRowID string
}

func (f *fakeCredentialStore) Load(_ context.Context, _ string) (string, Credentials, error) {
	return f.connectorRowID, f.creds, nil
}

func (f *fakeCredentialStore) Save(_ context.Context, _, _ string, creds Credentials) error {
	f.creds = creds
	return nil
}

const testTenantID = "55555555-5555-4555-8555-555555555555"

func newTestConnector(t *testing.T, mock *mockGoogleServer, applicationName string, dlq sentinelconnector.Publisher) *Connector {
	t.Helper()
	store := &fakeCredentialStore{
		connectorRowID: "connector-row-1",
		creds: Credentials{
			AccessToken:  "placeholder-pre-refresh-token",
			RefreshToken: "valid-refresh-token",
			ExpiresAt:    time.Now().Add(-time.Hour).Unix(), // already expired, forces an immediate refresh against the mock
			Scope:        "https://www.googleapis.com/auth/admin.reports.audit.readonly",
		},
	}
	cfg := OAuthConfig{ClientID: "test-client", ClientSecret: "test-secret", TokenEndpointBaseURL: mock.srv.URL}
	return NewConnector(testTenantID, applicationName, store, cfg, mock.srv.URL, mock.srv.Client(), dlq)
}

// T1 (unit half — the integration half against a mock honouring Google's
// documented contract is this same test, since there is no real Workspace
// test tenant available in this environment; see the PR/issue's own
// disclosure): Fetch produces one raw event per activity item, in order.
func TestFetch_ProducesExpectedRawEvents(t *testing.T) {
	mock := newMockGoogleServer()
	defer mock.close()
	mock.addItem("login", newActivityItem("login", "evt-1", "2024-01-01T00:00:00.000Z", "alice@example.com",
		activityEvent{Type: "login", Name: "login_success"}))
	mock.addItem("login", newActivityItem("login", "evt-2", "2024-01-01T00:05:00.000Z", "bob@example.com",
		activityEvent{Type: "login", Name: "login_failure"}))

	dlq := sentinelconnector.NewInMemoryPublisher()
	conn := newTestConnector(t, mock, "login", dlq)

	batch, nextCur, err := conn.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(batch.Events) != 2 {
		t.Fatalf("expected 2 raw events, got %d", len(batch.Events))
	}

	var ids []string
	for _, ev := range batch.Events {
		var rec rawEventRecord
		if err := json.Unmarshal(ev.Payload, &rec); err != nil {
			t.Fatalf("unmarshalling raw event record: %v", err)
		}
		var item activityItem
		if err := json.Unmarshal(rec.Item, &item); err != nil {
			t.Fatalf("unmarshalling item: %v", err)
		}
		ids = append(ids, item.ID.UniqueQualifier)
	}
	if ids[0] != "evt-1" || ids[1] != "evt-2" {
		t.Fatalf("expected events in order [evt-1, evt-2], got %v", ids)
	}

	var state cursorState
	if err := json.Unmarshal(nextCur, &state); err != nil {
		t.Fatalf("decoding next cursor: %v", err)
	}
	if state.LastUniqueQualifier != "evt-2" {
		t.Fatalf("expected cursor to checkpoint at evt-2, got %q", state.LastUniqueQualifier)
	}
}

// T4 (connector-level half): restart resumes without loss or duplication —
// a brand new Connector instance (simulating a real process restart) given
// the SAME committed cursor must not re-see already-processed items, and
// must see a genuinely new one. The Postgres-backed half of T4 ("cursor
// and checkpoint semantics survive a restart" against PostgresCursorStore
// specifically) is cursor_integration_test.go.
func TestFetch_RestartResumesWithoutLossOrDuplication(t *testing.T) {
	mock := newMockGoogleServer()
	defer mock.close()
	mock.addItem("drive", newActivityItem("drive", "evt-1", "2024-01-01T00:00:00.000Z", "carol@example.com",
		activityEvent{Type: "access", Name: "view"}))
	mock.addItem("drive", newActivityItem("drive", "evt-2", "2024-01-01T00:05:00.000Z", "carol@example.com",
		activityEvent{Type: "access", Name: "download"}))

	dlq := sentinelconnector.NewInMemoryPublisher()
	conn1 := newTestConnector(t, mock, "drive", dlq)
	batch1, cur1, err := conn1.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("first Fetch: %v", err)
	}
	if len(batch1.Events) != 2 {
		t.Fatalf("expected 2 events on first fetch, got %d", len(batch1.Events))
	}

	mock.addItem("drive", newActivityItem("drive", "evt-3", "2024-01-01T00:10:00.000Z", "carol@example.com",
		activityEvent{Type: "access", Name: "edit"}))

	conn2 := newTestConnector(t, mock, "drive", dlq) // brand new instance, same as a genuine restart
	batch2, _, err := conn2.Fetch(context.Background(), cur1)
	if err != nil {
		t.Fatalf("second Fetch (post-restart): %v", err)
	}
	if len(batch2.Events) != 1 {
		t.Fatalf("expected exactly 1 NEW event after restart, got %d", len(batch2.Events))
	}
	var rec rawEventRecord
	_ = json.Unmarshal(batch2.Events[0].Payload, &rec)
	var item activityItem
	_ = json.Unmarshal(rec.Item, &item)
	if item.ID.UniqueQualifier != "evt-3" {
		t.Fatalf("expected only evt-3 after restart, got %q", item.ID.UniqueQualifier)
	}
}

// An item with no events at all (Google's API permits this, e.g. a
// malformed or filtered-out activity) routes to the DLQ rather than being
// silently skipped — AC's "never dropped" taken seriously for Google too.
func TestFetch_ItemWithNoEventsRoutesToDLQ(t *testing.T) {
	mock := newMockGoogleServer()
	defer mock.close()
	mock.addItem("admin", newActivityItem("admin", "evt-empty", "2024-01-01T00:00:00.000Z", "dave@example.com"))
	mock.addItem("admin", newActivityItem("admin", "evt-good", "2024-01-01T00:05:00.000Z", "dave@example.com",
		activityEvent{Type: "user", Name: "CREATE_USER"}))

	dlq := sentinelconnector.NewInMemoryPublisher()
	conn := newTestConnector(t, mock, "admin", dlq)

	batch, _, err := conn.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(batch.Events) != 1 {
		t.Fatalf("expected 1 good event, got %d", len(batch.Events))
	}
	dlqd := dlq.Published(testTenantID)
	if len(dlqd) != 1 {
		t.Fatalf("expected exactly 1 dead-lettered message, got %d", len(dlqd))
	}
	var env deadLetterEnvelope
	if err := json.Unmarshal(dlqd[0].Payload, &env); err != nil {
		t.Fatalf("unmarshalling dead-letter envelope: %v", err)
	}
	if env.UniqueQualifier != "evt-empty" {
		t.Fatalf("expected the dead letter to identify evt-empty, got %q", env.UniqueQualifier)
	}
}

// A revoked refresh token surfaces Fetch's error as ErrConsentRevoked,
// mirroring m365's identical mapping.
func TestFetch_RevokedConsentSurfacesAsErrConsentRevoked(t *testing.T) {
	mock := newMockGoogleServer()
	defer mock.close()
	mock.revokedRefreshTok = "a-revoked-refresh-token"

	store := &fakeCredentialStore{
		connectorRowID: "connector-row-1",
		creds: Credentials{
			AccessToken:  "expired-access-token",
			RefreshToken: "a-revoked-refresh-token",
			ExpiresAt:    time.Now().Add(-time.Hour).Unix(),
		},
	}
	cfg := OAuthConfig{ClientID: "c", ClientSecret: "s", TokenEndpointBaseURL: mock.srv.URL}
	conn := NewConnector(testTenantID, "login", store, cfg, mock.srv.URL, mock.srv.Client(), sentinelconnector.NewInMemoryPublisher())

	_, _, err := conn.Fetch(context.Background(), nil)
	if err == nil {
		t.Fatal("expected Fetch to fail when the refresh token has been revoked")
	}
	if !errors.Is(err, sentinelconnector.ErrConsentRevoked) {
		t.Fatalf("expected the error to wrap ErrConsentRevoked, got: %v", err)
	}
}
