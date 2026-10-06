package m365

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
)

// mockM365Server is a local stand-in for BOTH Microsoft endpoints this
// package calls — the v2.0 token endpoint and the Management Activity
// API — honouring the same documented request/response shapes
// mock-m365-token-endpoint.ts (P1-02, TypeScript side) already established
// for the token half. "Recorded fixtures" (T1's own wording) means exactly
// this: a real HTTP server implementing Microsoft's own published contract,
// not a hand-wavy stub — the only thing missing is Microsoft's own servers
// and a real tenant (same disclosed gap P1-02 left for T1).
type mockM365Server struct {
	srv *httptest.Server

	mu                sync.Mutex
	m365TenantGUID    string
	contentByType     map[string][]mockBlob
	pageSize          int // 0 means "one page"
	refreshCount      int
	revokedRefreshTok string
	throttleNextN     int
	retryAfterSeconds int
}

type mockBlob struct {
	id      string
	created string // RFC3339
	body    []byte // exact bytes getContent should return
}

func newMockM365Server(m365TenantGUID string) *mockM365Server {
	m := &mockM365Server{
		m365TenantGUID: m365TenantGUID,
		contentByType:  make(map[string][]mockBlob),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/common/oauth2/v2.0/token", m.handleToken)
	mux.HandleFunc("/api/v1.0/", m.handleManagementAPI)
	mux.HandleFunc("/blob/", m.handleGetBlob)
	m.srv = httptest.NewServer(mux)
	return m
}

func (m *mockM365Server) close() { m.srv.Close() }

func (m *mockM365Server) addBlob(contentType, id, created string, body []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.contentByType[contentType] = append(m.contentByType[contentType], mockBlob{id: id, created: created, body: body})
}

// throttleNext makes the NEXT n requests to the list-content endpoint
// return 429 with the given Retry-After (seconds) before letting the
// (n+1)th through.
func (m *mockM365Server) throttleNext(n, retryAfterSeconds int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.throttleNextN = n
	m.retryAfterSeconds = retryAfterSeconds
}

func (m *mockM365Server) handleToken(w http.ResponseWriter, r *http.Request) {
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
			"error_description": "AADSTS70008: The refresh token has expired or is invalid because it was revoked.",
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"access_token":  fakeJWT(m.m365TenantGUID),
		"refresh_token": refreshToken,
		"expires_in":    3600,
		"scope":         "https://manage.office.com/ActivityFeed.Read",
	})
}

func (m *mockM365Server) handleManagementAPI(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasSuffix(r.URL.Path, "/activity/feed/subscriptions/start"):
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"contentType": r.URL.Query().Get("contentType"), "status": "enabled"})
	case strings.HasSuffix(r.URL.Path, "/activity/feed/subscriptions/content"):
		m.handleListContent(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (m *mockM365Server) handleListContent(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	if m.throttleNextN > 0 {
		m.throttleNextN--
		retryAfter := m.retryAfterSeconds
		m.mu.Unlock()
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	contentType := r.URL.Query().Get("contentType")
	all := append([]mockBlob{}, m.contentByType[contentType]...)
	pageSize := m.pageSize
	m.mu.Unlock()

	offset := 0
	if o := r.URL.Query().Get("offset"); o != "" {
		fmt.Sscanf(o, "%d", &offset)
	}

	end := len(all)
	if pageSize > 0 && offset+pageSize < end {
		end = offset + pageSize
	}
	page := all[offset:end]

	items := make([]contentItem, len(page))
	for i, b := range page {
		items[i] = contentItem{
			ContentURI:     m.srv.URL + "/blob/" + b.id,
			ContentID:      b.id,
			ContentType:    contentType,
			ContentCreated: b.created,
		}
	}

	if end < len(all) {
		w.Header().Set("NextPageUri", fmt.Sprintf("%s%s?contentType=%s&offset=%d", m.srv.URL, r.URL.Path, contentType, end))
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(items)
}

func (m *mockM365Server) handleGetBlob(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/blob/")
	m.mu.Lock()
	var body []byte
	found := false
	for _, blobs := range m.contentByType {
		for _, b := range blobs {
			if b.id == id {
				body = b.body
				found = true
			}
		}
	}
	m.mu.Unlock()
	if !found {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

// fakeJWT builds an unsigned (alg "none") JWT carrying only the "tid"
// claim m365TenantIDFromAccessToken reads — sufficient for this package's
// own parsing, which deliberately never verifies the signature (see that
// function's doc comment for why).
func fakeJWT(tid string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"tid":%q}`, tid)))
	return header + "." + payload + ".sig"
}
