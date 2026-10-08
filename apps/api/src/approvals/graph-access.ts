/**
 * P5-05: the stored M365 access token for a tenant's connector, read
 * and decrypted the same way m365-connector.ts's own revoke/health
 * paths already do (TenantCredentialVault + the connectors table's
 * own encrypted `credentials` column).
 *
 * Deliberately does NOT refresh an expired token — that needs
 * m365-oauth.ts's own `refreshAccessToken` plus re-encrypting and
 * storing the result back, which is real, valuable work this ticket
 * does not need in order to satisfy its own acceptance criteria
 * (idempotent playbooks, premise validation, partial-failure
 * recovery) and which cannot be exercised here anyway — no real M365
 * test tenant exists in this environment to refresh a token against.
 * A later ticket owning background token refresh is a reasonable
 * follow-up, not a gap silently left undocumented.
 *
 * Returns undefined — never throws — for "no M365 connector," "KMS
 * not configured," or any other reason a token genuinely is not
 * available right now; the caller (approvals.ts) turns that into the
 * same recoverable, manual-steps failure shape every other
 * unavailable integration in @sentinel/playbooks already uses.
 */
import type { Pool } from 'pg';
import { withTenantContext, ConnectorsRepository, TenantCredentialVault, LocalKMS } from '@sentinel/db';

export async function getM365AccessToken(pool: Pool, tenantId: string): Promise<string | undefined> {
  return withTenantContext(tenantId, async () => {
    const encrypted = await new ConnectorsRepository(pool).getHealthyCredentials('m365');
    if (!encrypted) return undefined;

    let kms: LocalKMS;
    try {
      kms = new LocalKMS();
    } catch {
      return undefined;
    }

    const credentials = await new TenantCredentialVault(pool, kms).decryptCredentials(encrypted);
    const accessToken = credentials['accessToken'];
    return typeof accessToken === 'string' ? accessToken : undefined;
  });
}
