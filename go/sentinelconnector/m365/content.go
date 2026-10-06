package m365

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// defaultManagementAPIBaseURL is the real Office 365 Management Activity
// API — https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-reference.
// Tests override it (managementAPI.baseURL) to point at a local mock that
// honours this same documented contract, same "recorded fixtures" framing
// P1-02's mock-m365-token-endpoint.ts already established.
const defaultManagementAPIBaseURL = "https://manage.office.com"

const maxThrottleRetries = 5

// contentItem is one entry from the "list available content" response —
// https://learn.microsoft.com/.../office-365-management-activity-api-reference#list-available-content.
type contentItem struct {
	ContentURI        string `json:"contentUri"`
	ContentID         string `json:"contentId"`
	ContentType       string `json:"contentType"`
	ContentCreated    string `json:"contentCreated"` // RFC3339
	ContentExpiration string `json:"contentExpiration"`
}

// managementAPI is a thin client for the three Management Activity API
// operations this connector needs: start a subscription (idempotent),
// enumerate available content blobs for one content type, and fetch one
// blob's raw bytes. It does not know about tenants, cursors or OCSF at
// all — connector.go owns that; this type only knows how to talk to
// Microsoft's documented HTTP contract, including honouring 429/Retry-After
// (AC3/T3) with real backoff rather than a hot retry loop.
type managementAPI struct {
	httpClient *http.Client
	baseURL    string
	sleep      func(context.Context, time.Duration) error
}

func newManagementAPI(httpClient *http.Client, baseURL string) *managementAPI {
	if baseURL == "" {
		baseURL = defaultManagementAPIBaseURL
	}
	return &managementAPI{httpClient: httpClient, baseURL: baseURL, sleep: sleepCtx}
}

// sleepCtx is context.Context-aware so a throttled retry wait is itself
// cancellable by shutdown (ADR's own graceful-drain expectations), unlike a
// bare time.Sleep.
func sleepCtx(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// doWithThrottleRetry issues req and, on a 429 response, sleeps for
// whatever Retry-After says (T3: "respected rather than hot-retried") and
// retries — up to maxThrottleRetries times, after which it gives up and
// returns an error rather than retrying forever. Every other status code
// (success or otherwise) is returned immediately on the first attempt.
func (m *managementAPI) doWithThrottleRetry(ctx context.Context, req *http.Request) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		resp, err := m.httpClient.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusTooManyRequests {
			return resp, nil
		}
		retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"))
		resp.Body.Close()
		if attempt >= maxThrottleRetries {
			return nil, fmt.Errorf("m365: throttled %d times in a row, giving up", attempt+1)
		}
		if err := m.sleep(ctx, retryAfter); err != nil {
			return nil, err
		}
	}
}

// parseRetryAfter reads the Retry-After header as a whole number of
// seconds (the form Microsoft's own API documents for 429 responses) and
// falls back to a conservative default if the header is missing or
// malformed — never zero, which would degrade into the hot-retry loop T3
// exists to rule out.
func parseRetryAfter(header string) time.Duration {
	const fallback = 5 * time.Second
	if header == "" {
		return fallback
	}
	seconds, err := strconv.Atoi(header)
	if err != nil || seconds <= 0 {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}

// subscribe starts (or confirms) a subscription for one content type.
// Idempotent per Microsoft's own documentation — calling "start" again for
// an already-active subscription simply returns its current status rather
// than erroring, so this is safe to call unconditionally every time a
// connector instance starts rather than needing its own persisted
// "have we already subscribed" flag.
func (m *managementAPI) subscribe(ctx context.Context, accessToken, m365TenantID, contentType string) error {
	endpoint := fmt.Sprintf("%s/api/v1.0/%s/activity/feed/subscriptions/start?contentType=%s", m.baseURL, m365TenantID, contentType)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		return fmt.Errorf("m365: building subscribe request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := m.doWithThrottleRetry(ctx, req)
	if err != nil {
		return fmt.Errorf("m365: subscribe request for %s failed: %w", contentType, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("m365: subscribe for %s returned %d: %s", contentType, resp.StatusCode, body)
	}
	return nil
}

// listAvailableContent enumerates every content item created in
// [startTime, endTime) for contentType, following every NextPageUri page
// Microsoft's API returns — Connector.Fetch (go/sentinelconnector's own
// doc comment) is expected to walk an entire vendor pagination itself and
// return the fully-collected result, so the scheduler never needs to know
// M365 paginates at all.
func (m *managementAPI) listAvailableContent(ctx context.Context, accessToken, m365TenantID, contentType, startTime, endTime string) ([]contentItem, error) {
	endpoint := fmt.Sprintf("%s/api/v1.0/%s/activity/feed/subscriptions/content?contentType=%s&startTime=%s&endTime=%s",
		m.baseURL, m365TenantID, contentType, startTime, endTime)

	var items []contentItem
	for endpoint != "" {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, fmt.Errorf("m365: building list-content request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+accessToken)

		resp, err := m.doWithThrottleRetry(ctx, req)
		if err != nil {
			return nil, fmt.Errorf("m365: list-content request for %s failed: %w", contentType, err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("m365: reading list-content response: %w", err)
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("m365: list-content for %s returned %d: %s", contentType, resp.StatusCode, body)
		}

		var page []contentItem
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, fmt.Errorf("m365: parsing list-content response: %w", err)
		}
		items = append(items, page...)
		endpoint = resp.Header.Get("NextPageUri")
	}
	return items, nil
}

// getContent fetches one blob's raw bytes verbatim — parsing (and routing
// a malformed blob to the DLQ) is connector.go's job, not this type's, so
// that the DLQ'd payload is always the exact bytes Microsoft returned.
func (m *managementAPI) getContent(ctx context.Context, accessToken, contentURI string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, contentURI, nil)
	if err != nil {
		return nil, fmt.Errorf("m365: building get-content request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := m.doWithThrottleRetry(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("m365: get-content request failed: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("m365: reading get-content response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("m365: get-content returned %d: %s", resp.StatusCode, body)
	}
	return body, nil
}
