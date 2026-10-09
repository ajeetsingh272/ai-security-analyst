// Package google is P7-01 — the Google Workspace Admin SDK Reports API
// collector, the second identity-platform connector built against
// docs/architecture/connector-developer-guide.md, following
// go/sentinelconnector/m365 as its closest analogue (also poll-based,
// also OAuth2, also a vendor "unified audit log" style API). It implements
// sentinelconnector.Connector and plugs into the scheduler the same way
// m365 does, at registerGoogleConnectors in services/ingest/cmd/ingest/main.go.
package google

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

// ID is the literal "kind" string — already a legal value in the
// connectors table's own check constraint since P1's foundation migration
// (db/postgres/migrations/0001_foundation.sql), so this connector needs no
// schema migration of its own.
const ID sentinelconnector.ConnectorID = "google_workspace"

// ApplicationNames is every Reports API applicationName AC2 requires
// ("Login, admin, Drive, Gmail and token audit activities are collected")
// — one independent cursor stream per name, mirroring m365.ContentTypes.
var ApplicationNames = []string{
	"login",
	"admin",
	"drive",
	"token",
	"gmail",
}

// lookbackWindow/maxWindowSpan are this package's own deliberate scope
// choices, not a Google-imposed limit — Google's Reports API, unlike
// Microsoft's, does not cap how large a [startTime,endTime) span may be in
// one call (pagination via pageToken handles arbitrarily large result
// sets). Bounding the window anyway keeps a brand-new connector's first
// cycle and every cycle's own cost predictable, mirroring m365's own
// defaults exactly.
const (
	lookbackWindow = 24 * time.Hour
	maxWindowSpan  = 24 * time.Hour
)

// cursorState is this connector's Cursor payload — the last processed
// activity's own (time, uniqueQualifier) pair, the same tie-break ordering
// m365's cursorState uses for its (ContentCreated, ContentID) pair, since
// Google's own uniqueQualifier (like M365's content id) carries no
// inherent ordering by itself.
type cursorState struct {
	LastEventTime       string `json:"lastEventTime,omitempty"`
	LastUniqueQualifier string `json:"lastUniqueQualifier,omitempty"`
}

// deadLetterEnvelope is what gets published to events.raw.dlq for an item
// that failed to parse — never dropped, preserved raw.
type deadLetterEnvelope struct {
	TenantID        string `json:"tenantId"`
	ApplicationName string `json:"applicationName"`
	UniqueQualifier string `json:"uniqueQualifier"`
	Reason          string `json:"reason"`
	RawContent      []byte `json:"rawContent"`
}

// Connector implements sentinelconnector.Connector for one (Sentinel
// tenant, Google applicationName) pair — one instance per ApplicationNames
// entry, each registered with its own Stream.
type Connector struct {
	tenantID        string
	applicationName string
	api             *reportsAPI
	tokens          *tokenProvider
	dlq             sentinelconnector.Publisher
	now             func() time.Time
}

// NewConnector wires one applicationName connector for one tenant.
// reportsAPIBaseURL/httpClient let tests point both the token endpoint and
// the Reports API at a local mock (empty baseURL means the real Google
// endpoint).
func NewConnector(
	tenantID, applicationName string,
	store credentialStorer,
	oauthCfg OAuthConfig,
	reportsAPIBaseURL string,
	httpClient *http.Client,
	dlq sentinelconnector.Publisher,
) *Connector {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	now := func() time.Time { return time.Now() }
	return &Connector{
		tenantID:        tenantID,
		applicationName: applicationName,
		api:             newReportsAPI(httpClient, reportsAPIBaseURL),
		tokens:          newTokenProvider(store, httpClient, oauthCfg, tenantID, func() int64 { return now().Unix() }),
		dlq:             dlq,
		now:             now,
	}
}

func (c *Connector) ID() sentinelconnector.ConnectorID { return ID }

// Fetch is ADR-0010's idempotent-per-cursor contract, satisfied the same
// way m365's Fetch satisfies it: listing activities and flattening them
// into individual records are both pure reads against Google's API; there
// is no subscribe-style side effect to make idempotent here at all (the
// Reports API needs no subscription step, unlike M365's Management
// Activity API).
func (c *Connector) Fetch(ctx context.Context, cur sentinelconnector.Cursor) (sentinelconnector.Batch, sentinelconnector.Cursor, error) {
	accessToken, err := c.tokens.accessToken(ctx)
	if err != nil {
		return sentinelconnector.Batch{}, nil, err
	}

	state := decodeCursor(cur)
	startTime, endTime := c.window(state)

	items, err := c.api.listActivities(ctx, accessToken, c.applicationName, startTime, endTime)
	if err != nil {
		return sentinelconnector.Batch{}, nil, err
	}

	items = filterAndSortNewItems(items, state)
	if len(items) == 0 {
		return sentinelconnector.Batch{}, cur, nil
	}

	var events []sentinelconnector.RawEvent
	for _, item := range items {
		itemBytes, err := json.Marshal(item)
		if err != nil {
			return sentinelconnector.Batch{}, nil, fmt.Errorf("google: re-encoding activity item: %w", err)
		}
		if len(item.Events) == 0 {
			if dlqErr := c.deadLetter(ctx, item, "activity item has no events", itemBytes); dlqErr != nil {
				return sentinelconnector.Batch{}, nil, dlqErr
			}
			continue
		}
		for i := range item.Events {
			record := rawEventRecord{Item: json.RawMessage(itemBytes), EventIndex: i}
			payload, err := json.Marshal(record)
			if err != nil {
				return sentinelconnector.Batch{}, nil, fmt.Errorf("google: encoding raw event record: %w", err)
			}
			events = append(events, sentinelconnector.RawEvent{
				TenantID:  c.tenantID,
				Payload:   payload,
				FetchedAt: c.now().Unix(),
			})
		}
	}

	last := items[len(items)-1]
	nextState := cursorState{LastEventTime: last.ID.Time, LastUniqueQualifier: last.ID.UniqueQualifier}
	nextCur, err := json.Marshal(nextState)
	if err != nil {
		return sentinelconnector.Batch{}, nil, fmt.Errorf("google: encoding cursor: %w", err)
	}

	return sentinelconnector.Batch{Events: events}, sentinelconnector.Cursor(nextCur), nil
}

func (c *Connector) deadLetter(ctx context.Context, item activityItem, reason string, raw []byte) error {
	env := deadLetterEnvelope{
		TenantID:        c.tenantID,
		ApplicationName: c.applicationName,
		UniqueQualifier: item.ID.UniqueQualifier,
		Reason:          reason,
		RawContent:      raw,
	}
	payload, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("google: encoding dead-letter envelope: %w", err)
	}
	if err := c.dlq.Publish(ctx, c.tenantID, []sentinelconnector.EventEnvelope{{TenantID: c.tenantID, Payload: payload}}); err != nil {
		return fmt.Errorf("google: publishing to dlq: %w", err)
	}
	return nil
}

// window computes [startTime, endTime) for the next list-activities call —
// identical shape to m365's own window(), see lookbackWindow/maxWindowSpan's
// doc comment for why this package imposes the same bound Google itself
// does not require.
func (c *Connector) window(state cursorState) (startTime, endTime string) {
	now := c.now().UTC()
	end := now

	if state.LastEventTime == "" {
		return now.Add(-lookbackWindow).Format(time.RFC3339), end.Format(time.RFC3339)
	}

	start, err := time.Parse(time.RFC3339Nano, state.LastEventTime)
	if err != nil {
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

// filterAndSortNewItems sorts items by (id.time, id.uniqueQualifier) and
// drops everything at or before the checkpoint — the same restart-resume
// guarantee m365's own filterAndSortNewItems proves (T4).
func filterAndSortNewItems(items []activityItem, state cursorState) []activityItem {
	sort.Slice(items, func(i, j int) bool {
		if items[i].ID.Time != items[j].ID.Time {
			return items[i].ID.Time < items[j].ID.Time
		}
		return items[i].ID.UniqueQualifier < items[j].ID.UniqueQualifier
	})

	if state.LastEventTime == "" {
		return items
	}
	out := items[:0:0]
	for _, item := range items {
		if item.ID.Time < state.LastEventTime {
			continue
		}
		if item.ID.Time == state.LastEventTime && item.ID.UniqueQualifier <= state.LastUniqueQualifier {
			continue
		}
		out = append(out, item)
	}
	return out
}

// Normalise wires this connector to MapEvent (ocsf_mapping.go) — exactly
// one event per RawEvent, same contract m365.Connector.Normalise satisfies.
func (c *Connector) Normalise(raw sentinelconnector.RawEvent) ([]ocsf.Event, error) {
	return []ocsf.Event{MapEvent(raw.TenantID, c.applicationName, raw.Payload, raw.FetchedAt)}, nil
}

// HealthCheck proves the connector can still authenticate — the same
// token-refresh path Fetch uses, surfacing ErrConsentRevoked the same way.
func (c *Connector) HealthCheck(ctx context.Context) error {
	_, err := c.tokens.accessToken(ctx)
	return err
}
