package google

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// defaultTokenEndpoint is Google's own OAuth 2.0 token endpoint —
// https://developers.google.com/identity/protocols/oauth2/web-server#offline.
// Tests override it (OAuthConfig.TokenEndpointBaseURL) to point at a local
// mock honouring this same documented contract, same framing
// mock-m365-token-endpoint.ts and this package's own mock_server_test.go
// already establish.
const defaultTokenEndpointBaseURL = "https://oauth2.googleapis.com"

// OAuthConfig is this package's half of apps/api/src/connectors/google-oauth.ts's
// GoogleOAuthConfig — only what token REFRESH needs, never the
// authorize/exchange half: the admin-consent flow itself stays TS-only and
// user-facing, exactly the M365 precedent (P1-02).
type OAuthConfig struct {
	ClientID             string
	ClientSecret         string
	TokenEndpointBaseURL string
}

func (c OAuthConfig) tokenEndpointBaseURL() string {
	if c.TokenEndpointBaseURL != "" {
		return c.TokenEndpointBaseURL
	}
	return defaultTokenEndpointBaseURL
}

// OAuthError mirrors google-oauth.ts's OAuthError — Code is Google's own
// error code (e.g. "invalid_grant"), not an HTTP status. Google's token
// error response shape ({"error":"...","error_description":"..."}) happens
// to be identical to Microsoft's own, so this package's error parsing is a
// straight port of m365's oauth.go.
type OAuthError struct {
	Description string
	Code        string
}

func (e *OAuthError) Error() string {
	return fmt.Sprintf("google: oauth error %s: %s", e.Code, e.Description)
}

// isInvalidGrant mirrors isConsentRevokedError(err) from google-oauth.ts —
// the signal that a refresh token can no longer be used because the tenant
// revoked (or never granted) consent.
func isInvalidGrant(err error) bool {
	var oauthErr *OAuthError
	return errors.As(err, &oauthErr) && oauthErr.Code == "invalid_grant"
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int64  `json:"expires_in"`
	Scope       string `json:"scope"`
	// Google deliberately does NOT return a new refresh_token on an
	// ordinary refresh call (unlike Microsoft, which may or may not) — the
	// original refresh token stays valid indefinitely until the user
	// revokes it or it is unused for 6 months. refreshAccessToken below
	// keeps using the SAME refresh token it was given, never expecting a
	// replacement.
}

type tokenErrorResponse struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

// scopes mirrors google-oauth.ts's GOOGLE_SCOPES exactly — a single,
// least-privilege, read-only scope (AC1's "read-only scopes"). No
// offline_access-equivalent scope is needed: Google issues a refresh token
// automatically whenever access_type=offline is requested at the authorize
// step (TS-side, not this package's concern).
var scopes = []string{
	"https://www.googleapis.com/auth/admin.reports.audit.readonly",
}

// refreshAccessToken is the Go port of google-oauth.ts's refreshAccessToken
// — same grant type and form parameters, against the same documented
// Google OAuth 2.0 token endpoint contract.
func refreshAccessToken(ctx context.Context, client *http.Client, cfg OAuthConfig, refreshToken string, now func() int64) (Credentials, error) {
	form := url.Values{}
	form.Set("client_id", cfg.ClientID)
	form.Set("client_secret", cfg.ClientSecret)
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refreshToken)

	endpoint := cfg.tokenEndpointBaseURL() + "/token"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return Credentials{}, fmt.Errorf("google: building token refresh request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := client.Do(req)
	if err != nil {
		return Credentials{}, fmt.Errorf("google: token refresh request failed: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return Credentials{}, fmt.Errorf("google: reading token refresh response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		var errBody tokenErrorResponse
		if jsonErr := json.Unmarshal(body, &errBody); jsonErr == nil && errBody.Error != "" {
			return Credentials{}, &OAuthError{Code: errBody.Error, Description: errBody.ErrorDescription}
		}
		return Credentials{}, fmt.Errorf("google: token refresh failed with status %d: %s", resp.StatusCode, body)
	}

	var tok tokenResponse
	if err := json.Unmarshal(body, &tok); err != nil {
		return Credentials{}, fmt.Errorf("google: parsing token refresh response: %w", err)
	}

	return Credentials{
		AccessToken:  tok.AccessToken,
		RefreshToken: refreshToken, // Google never rotates it on refresh — see tokenResponse's own doc comment
		ExpiresAt:    now() + tok.ExpiresIn,
		Scope:        tok.Scope,
	}, nil
}
