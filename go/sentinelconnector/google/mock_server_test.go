package google

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
)

// mockGoogleServer is a local stand-in for BOTH Google endpoints this
// package calls — the OAuth2 token endpoint and the Admin SDK Reports API
// — honouring the same documented request/response shapes real Google
// servers use. This is the package's own T1: "a real HTTP server
// implementing Google's own published contract" — the only thing missing
// is Google's own servers and a real Workspace test tenant, the identical
// disclosed gap m365's own mock_server_test.go (and before it,
// mock-m365-token-endpoint.ts) left for M365's equivalent T1.
type mockGoogleServer struct {
	srv *httptest.Server

	mu                sync.Mutex
	itemsByApp        map[string][]activityItem
	refreshCount      int
	revokedRefreshTok string
}

func newMockGoogleServer() *mockGoogleServer {
	m := &mockGoogleServer{itemsByApp: make(map[string][]activityItem)}
	mux := http.NewServeMux()
	mux.HandleFunc("/token", m.handleToken)
	mux.HandleFunc("/admin/reports/v1/activity/users/all/applications/", m.handleListActivities)
	m.srv = httptest.NewServer(mux)
	return m
}

func (m *mockGoogleServer) close() { m.srv.Close() }

func (m *mockGoogleServer) addItem(applicationName string, item activityItem) {
	m.mu.Lock()
	defer m.mu.Unlock()
	item.ID.ApplicationName = applicationName
	m.itemsByApp[applicationName] = append(m.itemsByApp[applicationName], item)
}

func (m *mockGoogleServer) handleToken(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	refreshToken := r.FormValue("refresh_token")

	m.mu.Lock()
	m.refreshCount++
	revoked := m.revokedRefreshTok != "" && refreshToken == m.revokedRefreshTok
	m.mu.Unlock()

	if revoked {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error":             "invalid_grant",
			"error_description": "Token has been expired or revoked.",
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"access_token": "fake-access-token",
		"expires_in":   3600,
		"scope":        "https://www.googleapis.com/auth/admin.reports.audit.readonly",
	})
}

func (m *mockGoogleServer) handleListActivities(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	appName := strings.TrimPrefix(r.URL.Path, "/admin/reports/v1/activity/users/all/applications/")
	items := append([]activityItem{}, m.itemsByApp[appName]...)
	m.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(activitiesListResponse{Items: items})
}

func newActivityItem(applicationName, uniqueQualifier, t, actorEmail string, events ...activityEvent) activityItem {
	item := activityItem{IPAddress: "203.0.113.1", Events: events}
	item.ID.ApplicationName = applicationName
	item.ID.UniqueQualifier = uniqueQualifier
	item.ID.Time = t
	item.Actor.Email = actorEmail
	return item
}
