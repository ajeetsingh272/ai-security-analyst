package m365

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// defaultAuthorityBaseURL is the real Microsoft identity platform v2.0
// authority — apps/api/src/connectors/m365-oauth.ts's own default, kept
// identical. Tests override it to point at a local mock, same pattern that
// file's own authorityBaseUrl field uses.
const defaultAuthorityBaseURL = "https://login.microsoftonline.com"

// OAuthConfig is this package's half of apps/api/src/connectors/m365-oauth.ts's
// M365OAuthConfig — only what token REFRESH needs (ClientID/ClientSecret),
// never the authorize/exchange half: the admin-consent flow itself stays
// TS-only and user-facing (P1-02). AuthorityBaseURL empty means the real
// Microsoft endpoint.
type OAuthConfig struct {
	ClientID         string
	ClientSecret     string
	AuthorityBaseURL string
}

func (c OAuthConfig) authorityBaseURL() string {
	if c.AuthorityBaseURL != "" {
		return c.AuthorityBaseURL
	}
	return defaultAuthorityBaseURL
}

// OAuthError mirrors m365-oauth.ts's OAuthError — Code is Microsoft's own
// error code (e.g. "invalid_grant"), not an HTTP status, so callers can
// recognise AADSTS70008-style revoked-consent responses the same way
// isConsentRevokedError does on the TS side.
type OAuthError struct {
	Description string
	Code        string
}

func (e *OAuthError) Error() string {
	return fmt.Sprintf("m365: oauth error %s: %s", e.Code, e.Description)
}

// isInvalidGrant mirrors isConsentRevokedError(err) from m365-oauth.ts —
// the specific signal that a refresh token can no longer be used because
// the tenant revoked (or never granted) consent, distinct from any other
// OAuthError code.
func isInvalidGrant(err error) bool {
	var oauthErr *OAuthError
	return errors.As(err, &oauthErr) && oauthErr.Code == "invalid_grant"
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
}

type tokenErrorResponse struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

// refreshAccessToken is the Go port of m365-oauth.ts's refreshAccessToken —
// same grant type, same form parameters, against the same documented
// Microsoft identity platform v2.0 token endpoint contract
// (mock-m365-token-endpoint.ts's own doc comment explains why a mock
// honouring that documented contract counts as a real exercise of this
// request/response shape, not a fake of "some HTTP server").
func refreshAccessToken(ctx context.Context, client *http.Client, cfg OAuthConfig, refreshToken string, now func() int64) (Credentials, error) {
	form := url.Values{}
	form.Set("client_id", cfg.ClientID)
	form.Set("client_secret", cfg.ClientSecret)
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refreshToken)
	form.Set("scope", strings.Join(scopes, " "))

	endpoint := cfg.authorityBaseURL() + "/common/oauth2/v2.0/token"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return Credentials{}, fmt.Errorf("m365: building token refresh request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := client.Do(req)
	if err != nil {
		return Credentials{}, fmt.Errorf("m365: token refresh request failed: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return Credentials{}, fmt.Errorf("m365: reading token refresh response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		var errBody tokenErrorResponse
		if jsonErr := json.Unmarshal(body, &errBody); jsonErr == nil && errBody.Error != "" {
			return Credentials{}, &OAuthError{Code: errBody.Error, Description: errBody.ErrorDescription}
		}
		return Credentials{}, fmt.Errorf("m365: token refresh failed with status %d: %s", resp.StatusCode, body)
	}

	var tok tokenResponse
	if err := json.Unmarshal(body, &tok); err != nil {
		return Credentials{}, fmt.Errorf("m365: parsing token refresh response: %w", err)
	}

	newRefreshToken := tok.RefreshToken
	if newRefreshToken == "" {
		// Microsoft may or may not rotate the refresh token on a refresh
		// call — if it didn't, keep using the one that still works.
		newRefreshToken = refreshToken
	}

	return Credentials{
		AccessToken:  tok.AccessToken,
		RefreshToken: newRefreshToken,
		ExpiresAt:    now() + tok.ExpiresIn,
		Scope:        tok.Scope,
	}, nil
}

// scopes mirrors m365-oauth.ts's M365_SCOPES exactly — least privilege,
// read-only (ActivityFeed.Read/ReadDlp) plus offline_access for the
// refresh token this package exists to use.
var scopes = []string{
	"https://manage.office.com/ActivityFeed.Read",
	"https://manage.office.com/ActivityFeed.ReadDlp",
	"offline_access",
}

// m365TenantIDFromAccessToken extracts the Azure AD tenant GUID (JWT claim
// "tid") from an access token WITHOUT verifying its signature. That is
// deliberate, not a shortcut: this token was just handed to this process
// directly by Microsoft's own token endpoint over TLS (refreshAccessToken,
// above) — it was never supplied by an untrusted caller, so there is nothing
// an attacker could have forged here to verify against. The scope
// requested (ActivityFeed.*, not openid/profile) means no id_token is ever
// issued, so this is the only source this package has for the tenant GUID
// the Management Activity API's URLs require — see content.go.
func m365TenantIDFromAccessToken(accessToken string) (string, error) {
	parts := strings.Split(accessToken, ".")
	if len(parts) != 3 {
		return "", fmt.Errorf("m365: access token is not a JWT (expected 3 parts, got %d)", len(parts))
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("m365: decoding JWT payload: %w", err)
	}
	var claims struct {
		Tid string `json:"tid"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return "", fmt.Errorf("m365: parsing JWT claims: %w", err)
	}
	if claims.Tid == "" {
		return "", errors.New("m365: access token has no tid claim")
	}
	return claims.Tid, nil
}
