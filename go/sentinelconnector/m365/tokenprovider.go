package m365

import (
	"context"
	"fmt"
	"net/http"
	"sync"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
)

// refreshSkew: refresh when the access token has less than this much life
// left, not only once it has already expired — a connector cycle that
// starts refreshing exactly at expiry risks the token dying mid-request.
const refreshSkewSeconds = 120

// tokenProvider ties CredentialStore (Postgres, decrypt/re-encrypt) and
// refreshAccessToken (the Microsoft token endpoint) together into the one
// thing M365Connector.Fetch actually needs: "give me a currently-valid
// access token," refreshing and persisting a new one only when necessary
// rather than once per cycle unconditionally — a real access token is
// valid for about an hour, far longer than this scheduler's one-minute
// interval, so refreshing every cycle would be both wasteful and far more
// likely to hit Microsoft's own throttling on the token endpoint itself.
// credentialStorer is the subset of *CredentialStore's methods
// tokenProvider actually needs — an interface (unexported: production
// callers never need to name it, they just pass a *CredentialStore, which
// satisfies it structurally) so tests can supply an in-memory fake instead
// of standing up a real Postgres for T1/T2/T4/T5, which are about this
// package's fetch/cursor/DLQ logic, not CredentialStore's own persistence
// (that has its own integration test against real Postgres — see
// credentials_integration_test.go).
type credentialStorer interface {
	Load(ctx context.Context, tenantID string) (connectorRowID string, creds Credentials, err error)
	Save(ctx context.Context, tenantID, connectorRowID string, creds Credentials) error
}

type tokenProvider struct {
	store      credentialStorer
	httpClient *http.Client
	cfg        OAuthConfig
	tenantID   string // Sentinel's own tenant UUID
	now        func() int64

	mu             sync.Mutex
	connectorRowID string
	cached         Credentials
	m365TenantID   string // Azure AD tenant GUID — see oauth.go's m365TenantIDFromAccessToken
	loaded         bool
}

func newTokenProvider(store credentialStorer, httpClient *http.Client, cfg OAuthConfig, tenantID string, now func() int64) *tokenProvider {
	return &tokenProvider{store: store, httpClient: httpClient, cfg: cfg, tenantID: tenantID, now: now}
}

// accessToken returns a currently-valid access token and the Azure AD
// tenant GUID the Management Activity API's URLs are keyed by, refreshing
// and persisting (via CredentialStore.Save) whenever the cached token is
// within refreshSkewSeconds of expiry. A refresh that fails with
// "invalid_grant" is surfaced as ErrConsentRevoked, not a generic error —
// the scheduler maps that to the connectors table's 'revoked' status
// (sentinelconnector.healthStatusFor).
func (p *tokenProvider) accessToken(ctx context.Context) (accessToken, m365TenantID string, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if !p.loaded {
		connectorRowID, creds, err := p.store.Load(ctx, p.tenantID)
		if err != nil {
			return "", "", p.mapLoadErr(err)
		}
		p.connectorRowID = connectorRowID
		p.cached = creds
		p.loaded = true
	}

	if p.now() < p.cached.ExpiresAt-refreshSkewSeconds {
		if p.m365TenantID == "" {
			tid, err := m365TenantIDFromAccessToken(p.cached.AccessToken)
			if err != nil {
				return "", "", err
			}
			p.m365TenantID = tid
		}
		return p.cached.AccessToken, p.m365TenantID, nil
	}

	refreshed, err := refreshAccessToken(ctx, p.httpClient, p.cfg, p.cached.RefreshToken, p.now)
	if err != nil {
		if isInvalidGrant(err) {
			return "", "", fmt.Errorf("m365: refresh token revoked: %w", sentinelconnector.ErrConsentRevoked)
		}
		return "", "", fmt.Errorf("m365: refreshing access token: %w", err)
	}
	if err := p.store.Save(ctx, p.tenantID, p.connectorRowID, refreshed); err != nil {
		// The refreshed token is still usable for THIS cycle even if
		// persisting it failed — returning it rather than erroring out
		// avoids discarding a perfectly good token over a transient
		// Postgres write failure. The NEXT cycle will simply refresh
		// again, which is wasteful but not incorrect.
		p.cached = refreshed
		tid, tidErr := m365TenantIDFromAccessToken(refreshed.AccessToken)
		if tidErr != nil {
			return "", "", tidErr
		}
		p.m365TenantID = tid
		return refreshed.AccessToken, tid, nil
	}
	p.cached = refreshed
	tid, err := m365TenantIDFromAccessToken(refreshed.AccessToken)
	if err != nil {
		return "", "", err
	}
	p.m365TenantID = tid
	return refreshed.AccessToken, tid, nil
}

func (p *tokenProvider) mapLoadErr(err error) error {
	if err == ErrNotConnected {
		return fmt.Errorf("m365: %w: %w", ErrNotConnected, sentinelconnector.ErrConsentRevoked)
	}
	return err
}
