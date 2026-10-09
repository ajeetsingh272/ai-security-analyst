package google

import (
	"context"
	"fmt"
	"net/http"
	"sync"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
)

// refreshSkewSeconds mirrors m365's own tokenprovider.go exactly — refresh
// when the access token has less than this much life left, not only once
// it has already expired.
const refreshSkewSeconds = 120

// credentialStorer is the subset of *CredentialStore's methods
// tokenProvider needs — unexported, same reasoning m365's own
// credentialStorer gives: production callers pass a *CredentialStore
// (which satisfies it structurally), tests supply an in-memory fake.
type credentialStorer interface {
	Load(ctx context.Context, tenantID string) (connectorRowID string, creds Credentials, err error)
	Save(ctx context.Context, tenantID, connectorRowID string, creds Credentials) error
}

// tokenProvider ties CredentialStore and refreshAccessToken together —
// unlike m365's own tokenProvider, Google's Reports API URL needs no
// second vendor-tenant identifier extracted from the access token (no
// "tid"-claim equivalent): the URL is simply
// .../activity/users/all/applications/{applicationName}, scoped to
// whichever domain the OAuth credentials themselves belong to.
type tokenProvider struct {
	store      credentialStorer
	httpClient *http.Client
	cfg        OAuthConfig
	tenantID   string // Sentinel's own tenant UUID
	now        func() int64

	mu             sync.Mutex
	connectorRowID string
	cached         Credentials
	loaded         bool
}

func newTokenProvider(store credentialStorer, httpClient *http.Client, cfg OAuthConfig, tenantID string, now func() int64) *tokenProvider {
	return &tokenProvider{store: store, httpClient: httpClient, cfg: cfg, tenantID: tenantID, now: now}
}

// accessToken returns a currently-valid access token, refreshing and
// persisting whenever the cached token is within refreshSkewSeconds of
// expiry. A refresh that fails with "invalid_grant" is surfaced as
// ErrConsentRevoked, matching m365's own mapping.
func (p *tokenProvider) accessToken(ctx context.Context) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if !p.loaded {
		connectorRowID, creds, err := p.store.Load(ctx, p.tenantID)
		if err != nil {
			return "", p.mapLoadErr(err)
		}
		p.connectorRowID = connectorRowID
		p.cached = creds
		p.loaded = true
	}

	if p.now() < p.cached.ExpiresAt-refreshSkewSeconds {
		return p.cached.AccessToken, nil
	}

	refreshed, err := refreshAccessToken(ctx, p.httpClient, p.cfg, p.cached.RefreshToken, p.now)
	if err != nil {
		if isInvalidGrant(err) {
			return "", fmt.Errorf("google: refresh token revoked: %w", sentinelconnector.ErrConsentRevoked)
		}
		return "", fmt.Errorf("google: refreshing access token: %w", err)
	}
	if err := p.store.Save(ctx, p.tenantID, p.connectorRowID, refreshed); err != nil {
		// The refreshed token is still usable for THIS cycle even if
		// persisting it failed — same deliberate choice m365's own
		// tokenProvider makes, rather than discarding a good token over a
		// transient Postgres write failure.
		p.cached = refreshed
		return refreshed.AccessToken, nil
	}
	p.cached = refreshed
	return refreshed.AccessToken, nil
}

func (p *tokenProvider) mapLoadErr(err error) error {
	if err == ErrNotConnected {
		return fmt.Errorf("google: %w: %w", ErrNotConnected, sentinelconnector.ErrConsentRevoked)
	}
	return err
}
