/**
 * Ties the two envelope-encryption layers (envelope.ts's DEK, kms.ts's KEK
 * wrapping) to the one place a tenant's DEK actually lives — tenant_deks
 * (0005_tenant_deks.sql) — and exposes the two operations a connector's
 * OAuth credentials actually need: encrypt a fresh token set, decrypt a
 * stored one. Nothing outside this file ever handles a raw DEK.
 */
import type { Pool, PoolClient } from 'pg';
import { TenantScopedRepository } from '../tenant-context.js';
import { generateDEK, encryptWithDEK, decryptWithDEK } from './envelope.js';
import type { KeyManagementService } from './kms.js';

interface TenantDekRow {
  wrapped_dek: Buffer;
  kms_key_id: string;
}

export interface EncryptedCredentials {
  /** Goes straight into connectors.credentials. */
  encrypted: Buffer;
  /** Goes into connectors.dek_id — which KEK version wrapped the DEK that
   * encrypted THIS blob, for audit visibility across a future KEK
   * rotation. Decryption itself never reads this column back: it always
   * re-fetches the tenant's one current tenant_deks row (ADR-0008's
   * "per-tenant DEK", not "per-connector" or "per-encryption-call"). */
  dekId: string;
}

export class TenantCredentialVault extends TenantScopedRepository {
  constructor(
    pool: Pool,
    private readonly kms: KeyManagementService,
  ) {
    super(pool);
  }

  async encryptCredentials(plaintext: Record<string, unknown>): Promise<EncryptedCredentials> {
    const { dek, keyId } = await this.getOrCreateDEK();
    const encrypted = encryptWithDEK(dek, Buffer.from(JSON.stringify(plaintext), 'utf8'));
    return { encrypted, dekId: keyId };
  }

  async decryptCredentials(encrypted: Buffer): Promise<Record<string, unknown>> {
    const { dek } = await this.getOrCreateDEK();
    const plaintext = decryptWithDEK(dek, encrypted);
    return JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>;
  }

  /**
   * Returns this tenant's DEK, creating and storing a wrapped one on
   * first use. The KMS call (wrapDEK/unwrapDEK) deliberately happens
   * OUTSIDE any held Postgres transaction — fine for LocalKMS's local AES
   * op, but the thing that matters once a real network-calling cloud KMS
   * is plugged in later: a Postgres connection should never sit open
   * for the duration of a network round trip to somewhere else.
   */
  private async getOrCreateDEK(): Promise<{ dek: Buffer; keyId: string }> {
    const existing = await this.withTransaction(async (client: PoolClient) => {
      const { rows } = await client.query<TenantDekRow>(
        'SELECT wrapped_dek, kms_key_id FROM tenant_deks WHERE tenant_id = $1',
        [this.tenantId],
      );
      return rows[0] ?? null;
    });
    if (existing) {
      const dek = await this.kms.unwrapDEK(existing.wrapped_dek, existing.kms_key_id);
      return { dek, keyId: existing.kms_key_id };
    }

    const dek = generateDEK();
    const { wrapped, keyId } = await this.kms.wrapDEK(dek);

    // ON CONFLICT DO UPDATE (a no-op SET) with RETURNING, not DO NOTHING:
    // this always returns the row that's ACTUALLY there after the
    // statement, whichever of two concurrent "first connector for this
    // tenant" requests won the race — DO NOTHING would return zero rows
    // for the loser, silently discarding a DEK it generated with nothing
    // telling it to go re-read what won instead.
    const row = await this.withTransaction(async (client: PoolClient) => {
      const { rows } = await client.query<TenantDekRow>(
        `INSERT INTO tenant_deks (tenant_id, wrapped_dek, kms_key_id) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
         RETURNING wrapped_dek, kms_key_id`,
        [this.tenantId, wrapped, keyId],
      );
      return rows[0]!;
    });

    if (!row.wrapped_dek.equals(wrapped)) {
      // Lost the race — unwrap the WINNING row's DEK instead of trusting
      // the one generated locally, which was never actually stored.
      const winningDek = await this.kms.unwrapDEK(row.wrapped_dek, row.kms_key_id);
      return { dek: winningDek, keyId: row.kms_key_id };
    }
    return { dek, keyId: row.kms_key_id };
  }
}
