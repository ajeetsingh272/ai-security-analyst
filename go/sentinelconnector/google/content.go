package google

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// defaultReportsAPIBaseURL is the real Admin SDK Reports API —
// https://developers.google.com/admin-sdk/reports/v1/reference/activities/list.
// Tests override it to point at a local mock honouring this same
// documented contract.
const defaultReportsAPIBaseURL = "https://admin.googleapis.com"

const maxThrottleRetries = 5

// activitiesListResponse is the Reports API's own response envelope —
// https://developers.google.com/admin-sdk/reports/v1/reference/activities/list.
type activitiesListResponse struct {
	Items         []activityItem `json:"items"`
	NextPageToken string         `json:"nextPageToken"`
}

// googleAPIErrorBody is Google's standard error envelope, used here to
// recognise a quota/rate-limit 403 the same way a plain 429 is recognised
// (Google's Reports API returns either, depending on which limit was hit) —
// https://developers.google.com/admin-sdk/reports/v1/limits.
type googleAPIErrorBody struct {
	Error struct {
		Code   int `json:"code"`
		Errors []struct {
			Reason string `json:"reason"`
		} `json:"errors"`
	} `json:"error"`
}

func (b googleAPIErrorBody) isRateLimited() bool {
	for _, e := range b.Error.Errors {
		if e.Reason == "rateLimitExceeded" || e.Reason == "quotaExceeded" || e.Reason == "userRateLimitExceeded" {
			return true
		}
	}
	return false
}

// reportsAPI is a thin client for the one Reports API operation this
// connector needs — list activities for one applicationName, following
// nextPageToken across pages — mirroring m365's own managementAPI: it does
// not know about tenants, cursors or OCSF; connector.go owns that.
type reportsAPI struct {
	httpClient *http.Client
	baseURL    string
	sleep      func(context.Context, time.Duration) error
}

func newReportsAPI(httpClient *http.Client, baseURL string) *reportsAPI {
	if baseURL == "" {
		baseURL = defaultReportsAPIBaseURL
	}
	return &reportsAPI{httpClient: httpClient, baseURL: baseURL, sleep: sleepCtx}
}

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

// doWithThrottleRetry issues req and, on a 429 or a quota-exceeded 403,
// sleeps (honouring Retry-After when present, a 5s fallback otherwise —
// Google does not always set it, unlike Microsoft) and retries, up to
// maxThrottleRetries times.
func (r *reportsAPI) doWithThrottleRetry(ctx context.Context, req *http.Request) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		resp, err := r.httpClient.Do(req)
		if err != nil {
			return nil, err
		}
		if !isThrottled(resp) {
			return resp, nil
		}
		retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"))
		resp.Body.Close()
		if attempt >= maxThrottleRetries {
			return nil, fmt.Errorf("google: throttled %d times in a row, giving up", attempt+1)
		}
		if err := r.sleep(ctx, retryAfter); err != nil {
			return nil, err
		}
	}
}

func isThrottled(resp *http.Response) bool {
	if resp.StatusCode == http.StatusTooManyRequests {
		return true
	}
	if resp.StatusCode != http.StatusForbidden {
		return false
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))
	var errBody googleAPIErrorBody
	return json.Unmarshal(body, &errBody) == nil && errBody.isRateLimited()
}

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

// listActivities enumerates every activity item for applicationName with
// id.time in [startTime, endTime), following every nextPageToken the
// Reports API returns — Connector.Fetch is expected to walk an entire
// vendor pagination itself and return the fully-collected result, same
// contract m365's own listAvailableContent satisfies.
func (r *reportsAPI) listActivities(ctx context.Context, accessToken, applicationName, startTime, endTime string) ([]activityItem, error) {
	var items []activityItem
	pageToken := ""
	for {
		endpoint := fmt.Sprintf("%s/admin/reports/v1/activity/users/all/applications/%s?startTime=%s&endTime=%s",
			r.baseURL, applicationName, url.QueryEscape(startTime), url.QueryEscape(endTime))
		if pageToken != "" {
			endpoint += "&pageToken=" + url.QueryEscape(pageToken)
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, fmt.Errorf("google: building list-activities request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+accessToken)

		resp, err := r.doWithThrottleRetry(ctx, req)
		if err != nil {
			return nil, fmt.Errorf("google: list-activities request for %s failed: %w", applicationName, err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("google: reading list-activities response: %w", err)
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("google: list-activities for %s returned %d: %s", applicationName, resp.StatusCode, body)
		}

		var page activitiesListResponse
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, fmt.Errorf("google: parsing list-activities response: %w", err)
		}
		items = append(items, page.Items...)
		if page.NextPageToken == "" {
			break
		}
		pageToken = page.NextPageToken
	}
	return items, nil
}
