import { describe, expect, it } from 'vitest';
import { externalIdForTenant } from '../routes/aws-connector.js';

describe('externalIdForTenant', () => {
  it('is deterministic — the same secret and tenant id always produce the same external id', () => {
    const a = externalIdForTenant('secret-1', 'tenant-abc');
    const b = externalIdForTenant('secret-1', 'tenant-abc');
    expect(a).toBe(b);
  });

  it('differs across tenants, for the same secret', () => {
    const a = externalIdForTenant('secret-1', 'tenant-abc');
    const b = externalIdForTenant('secret-1', 'tenant-xyz');
    expect(a).not.toBe(b);
  });

  it('differs across secrets, for the same tenant', () => {
    const a = externalIdForTenant('secret-1', 'tenant-abc');
    const b = externalIdForTenant('secret-2', 'tenant-abc');
    expect(a).not.toBe(b);
  });

  it('is a safe charset to paste into an IAM trust policy condition (hex)', () => {
    const id = externalIdForTenant('secret-1', 'tenant-abc');
    expect(id).toMatch(/^[0-9a-f]+$/);
  });
});
