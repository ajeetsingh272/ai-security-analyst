// Package m365 is P1-03 (the M365 Management Activity API collector —
// subscribe, enumerate content blobs, fetch and parse them, checkpoint by
// blob id) plus P1-04 (OCSF normalisation — see ocsf_mapping.go). It
// implements sentinelconnector.Connector (P1-01's framework) and plugs
// into the scheduler exactly the way that package's own doc comment
// describes, at the TODO(P1-02/P1-03) spot in
// services/ingest/cmd/ingest/main.go.
package m365

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
)

// ID is the literal "kind" string — matches the connectors table's own
// check constraint (db/postgres/migrations/0001_foundation.sql) and
// go/sentinelconnector's own ConnectorID doc comment.
const ID sentinelconnector.ConnectorID = "m365"

// ContentTypes is every content type AC1 requires a subscription to —
// four independent streams, each with its own cursor
// (go/sentinelconnector/scheduler.go's TenantConnector.Stream), because
// Microsoft's own API partitions content by type and there is no ordering
// guarantee ACROSS types, only within one.
var ContentTypes = []string{
	"Audit.Exchange",
	"Audit.SharePoint",
	"Audit.AzureActiveDirectory",
	"Audit.General",
}

// lookbackWindow bounds how far back a connector with no prior cursor (a
// brand new registration) looks for content — Microsoft's API supports up
// to 7 days, but defaulting to 24h avoids a large, unbounded backfill on
// first run; this is a deliberate scope choice for P1-03, not a Microsoft
// API limit.
const lookbackWindow = 24 * time.Hour

// maxWindowSpan is Microsoft's own documented limit: startTime/endTime in
// one list-content call may span at most 24 hours.
const maxWindowSpan = 24 * time.Hour

// cursorState is this connector's Cursor payload — the blob id (AC2:
// "Blob ids form the checkpoint") plus its creation timestamp as the
// ordering key, since content ids themselves carry no inherent order.
// LastContentCreated+LastContentID together form the tie-breaker: items
// are skipped only once both match, so two items created in the exact same
// instant are still each processed exactly once across a restart (T2).
type cursorState struct {
	LastContentCreated string `json:"lastContentCreated,omitempty"`
	LastContentID      string `json:"lastContentId,omitempty"`
}

// deadLetterEnvelope is what gets published to events.raw.dlq for a blob
// that failed to parse — AC3: "raw content preserved", never dropped. The
// RawContent field is EXACTLY what Microsoft's API returned for this blob,
// byte for byte.
type deadLetterEnvelope struct {
	TenantID    string `json:"tenantId"`
	ContentType string `json:"contentType"`
	ContentID   string `json:"contentId"`
	ContentURI  string `json:"contentUri"`
	Reason      string `json:"reason"`
	RawContent  []byte `json:"rawContent"`
}

// Connector implements sentinelconnector.Connector for one (Sentinel
// tenant, M365 content type) pair — one instance per ContentTypes entry,
// each registered with its own Stream (see RegisterAll in registry.go).
type Connector struct {
	tenantID    string
	contentType string
	api         *managementAPI
	tokens      *tokenProvider
	dlq         sentinelconnector.Publisher // events.raw.dlq, same Publisher interface the scheduler itself uses (see registry.go)
	now         func() time.Time

	subscribed bool
}

// NewConnector wires one content-type connector for one tenant. httpClient
// lets tests point both the token endpoint and the Management API at a
// local mock (managementAPIBaseURL empty means the real Microsoft
// endpoint).
func NewConnector(
	tenantID, contentType string,
	store credentialStorer,
	oauthCfg OAuthConfig,
	managementAPIBaseURL string,
	httpClient *http.Client,
	dlq sentinelconnector.Publisher,
) *Connector {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	now := func() time.Time { return time.Now() }
	return &Connector{
		tenantID:    tenantID,
		contentType: contentType,
		api:         newManagementAPI(httpClient, managementAPIBaseURL),
		tokens:      newTokenProvider(store, httpClient, oauthCfg, tenantID, func() int64 { return now().Unix() }),
		dlq:         dlq,
		now:         now,
	}
}

func (c *Connector) ID() sentinelconnector.ConnectorID { return ID }

// Fetch is ADR-0010's idempotent-per-cursor contract: re-calling it with
// the same cursor after a crash must be safe, because the scheduler's
// recovery path does exactly that. Nothing here has a side effect that
// isn't safe to repeat — listing content and fetching a blob are both
// pure reads against Microsoft's API; the only mutation (subscribing, and
// persisting a refreshed token) is itself idempotent.
func (c *Connector) Fetch(ctx context.Context, cur sentinelconnector.Cursor) (sentinelconnector.Batch, sentinelconnector.Cursor, error) {
	accessToken, m365TenantID, err := c.tokens.accessToken(ctx)
	if err != nil {
		return sentinelconnector.Batch{}, nil, err
	}

	if !c.subscribed {
		if err := c.api.subscribe(ctx, accessToken, m365TenantID, c.contentType); err != nil {
			return sentinelconnector.Batch{}, nil, err
		}
		c.subscribed = true
	}

	state := decodeCursor(cur)
	startTime, endTime := c.window(state)

	items, err := c.api.listAvailableContent(ctx, accessToken, m365TenantID, c.contentType, startTime, endTime)
	if err != nil {
		return sentinelconnector.Batch{}, nil, err
	}

	items = filterAndSortNewItems(items, state)
	if len(items) == 0 {
		return sentinelconnector.Batch{}, cur, nil
	}

	var events []sentinelconnector.RawEvent
	for _, item := range items {
		raw, err := c.api.getContent(ctx, accessToken, item.ContentURI)
		if err != nil {
			return sentinelconnector.Batch{}, nil, err
		}

		var records []json.RawMessage
		if err := json.Unmarshal(raw, &records); err != nil {
			if dlqErr := c.deadLetter(ctx, item, "malformed_blob: "+err.Error(), raw); dlqErr != nil {
				return sentinelconnector.Batch{}, nil, dlqErr
			}
			continue // AC3: cursor still advances past a dead-lettered blob — "never dropped" means preserved in the DLQ, not retried forever.
		}

		for _, record := range records {
			events = append(events, sentinelconnector.RawEvent{
				TenantID:  c.tenantID,
				Payload:   record,
				FetchedAt: c.now().Unix(),
			})
		}
	}

	last := items[len(items)-1]
	nextState := cursorState{LastContentCreated: last.ContentCreated, LastContentID: last.ContentID}
	nextCur, err := json.Marshal(nextState)
	if err != nil {
		return sentinelconnector.Batch{}, nil, fmt.Errorf("m365: encoding cursor: %w", err)
	}

	return sentinelconnector.Batch{Events: events}, sentinelconnector.Cursor(nextCur), nil
}

func (c *Connector) deadLetter(ctx context.Context, item contentItem, reason string, raw []byte) error {
	env := deadLetterEnvelope{
		TenantID:    c.tenantID,
		ContentType: item.ContentType,
		ContentID:   item.ContentID,
		ContentURI:  item.ContentURI,
		Reason:      reason,
		RawContent:  raw,
	}
	payload, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("m365: encoding dead-letter envelope: %w", err)
	}
	if err := c.dlq.Publish(ctx, c.tenantID, []sentinelconnector.EventEnvelope{{TenantID: c.tenantID, Payload: payload}}); err != nil {
		return fmt.Errorf("m365: publishing to dlq: %w", err)
	}
	return nil
}

// window computes [startTime, endTime) for the next list-content call:
// resuming from the last checkpoint if there is one (capped to
// maxWindowSpan, Microsoft's own limit), or lookbackWindow on a connector's
// first-ever cycle.
func (c *Connector) window(state cursorState) (startTime, endTime string) {
	now := c.now().UTC()
	end := now

	if state.LastContentCreated == "" {
		return now.Add(-lookbackWindow).Format(time.RFC3339), end.Format(time.RFC3339)
	}

	start, err := time.Parse(time.RFC3339, state.LastContentCreated)
	if err != nil {
		// Shouldn't happen (we wrote this value ourselves), but a
		// malformed checkpoint should degrade to "look back the default
		// window" rather than crash the connector permanently.
		return now.Add(-lookbackWindow).Format(time.RFC3339), end.Format(time.RFC3339)
	}
	if now.Sub(start) > maxWindowSpan {
		start = now.Add(-maxWindowSpan)
	}
	return start.Format(time.RFC3339), end.Format(time.RFC3339)
}

func decodeCursor(cur sentinelconnector.Cursor) cursorState {
	if len(cur) == 0 {
		return cursorState{}
	}
	var state cursorState
	_ = json.Unmarshal(cur, &state) // malformed/empty cursor degrades to "treat as first run", never a crash
	return state
}

// filterAndSortNewItems sorts items by (contentCreated, contentId) and
// drops everything at or before the checkpoint — AC2's "a restart resumes
// exactly where it stopped," proven by T2.
func filterAndSortNewItems(items []contentItem, state cursorState) []contentItem {
	sort.Slice(items, func(i, j int) bool {
		if items[i].ContentCreated != items[j].ContentCreated {
			return items[i].ContentCreated < items[j].ContentCreated
		}
		return items[i].ContentID < items[j].ContentID
	})

	if state.LastContentCreated == "" {
		return items
	}
	out := items[:0:0] //nolint — explicit zero-cap slice, not reusing items' backing array while iterating it below
	for _, item := range items {
		if item.ContentCreated < state.LastContentCreated {
			continue
		}
		if item.ContentCreated == state.LastContentCreated && item.ContentID <= state.LastContentID {
			continue
		}
		out = append(out, item)
	}
	return out
}

// Normalise is P1-04's deliverable, wired here as the one line that
// connects this connector to that pure function — see ocsf_mapping.go's
// MapEvent for the actual mapping logic, AC1's "no I/O, no clock, no
// network" is enforced by this method having nothing to pass it besides
// raw.Payload/raw.TenantID/raw.FetchedAt and c.contentType (a plain
// string, not a client).
func (c *Connector) Normalise(raw sentinelconnector.RawEvent) ([]ocsf.Event, error) {
	return []ocsf.Event{MapEvent(raw.TenantID, c.contentType, raw.Payload, raw.FetchedAt)}, nil
}

// HealthCheck proves the connector can still authenticate — the same
// token-refresh path Fetch uses, surfacing ErrConsentRevoked the same way
// (AC4/T4 in P1-02's own ticket; this package is what makes that path real
// for M365 specifically).
func (c *Connector) HealthCheck(ctx context.Context) error {
	_, _, err := c.tokens.accessToken(ctx)
	return err
}
