package aws

import (
	"errors"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
)

// roleSessionName identifies Sentinel's own side of every assumed-role
// session in the customer's own CloudTrail — AC1's own spirit ("documented
// for the customer") extends to this: an admin reviewing their account's
// STS activity should see a session name that is obviously Sentinel's,
// not an anonymous "AssumeRoleSession".
const roleSessionName = "sentinel-cloudtrail-connector"

// newCredentialsProvider builds the STS AssumeRole credential provider for
// one tenant's connector, wrapped in aws.CredentialsCache so repeated use
// within one process only calls AssumeRole again once the temporary
// session nears expiry — the same "don't refresh every cycle
// unconditionally" reasoning m365/google's own tokenProvider gives,
// except here the SDK's own CredentialsCache does it, not
// hand-rolled logic, since aws.CredentialsCache is exactly the mechanism
// the SDK provides for this.
//
// client is stscreds.AssumeRoleAPIClient — a one-method interface
// *sts.Client satisfies structurally — so production passes a real STS
// client and tests pass a fake with no real network/credentials at all,
// the same "narrow interface, concrete type satisfies it, fake for
// tests" shape m365/google's own credentialStorer interfaces use.
func newCredentialsProvider(client stscreds.AssumeRoleAPIClient, creds Credentials) *awssdk.CredentialsCache {
	provider := stscreds.NewAssumeRoleProvider(client, creds.RoleArn, func(o *stscreds.AssumeRoleOptions) {
		o.RoleSessionName = roleSessionName
		if creds.ExternalID != "" {
			o.ExternalID = awssdk.String(creds.ExternalID)
		}
	})
	return awssdk.NewCredentialsCache(provider)
}

// stsErrorIsAccessDenied recognises STS's own access-denied shape for a
// role that no longer trusts Sentinel's account/external id (the customer
// edited or deleted the trust policy, or the role itself) — this
// connector's equivalent of M365/Google's isInvalidGrant, surfaced the
// same way: as sentinelconnector.ErrConsentRevoked, not a generic error,
// so the scheduler's health status can tell "needs the customer to
// re-authorise" apart from "AWS is having a bad day."
//
// AWS's STS AssumeRole error for a denied/untrusted role is an
// AccessDenied API error — smithy-go's generic APIError carries the real
// code string, same shape this function checks for.
func stsErrorIsAccessDenied(err error) bool {
	type apiError interface {
		ErrorCode() string
	}
	var apiErr apiError
	if !errors.As(err, &apiErr) {
		return false
	}
	return apiErr.ErrorCode() == "AccessDenied" || apiErr.ErrorCode() == "AccessDeniedException"
}
