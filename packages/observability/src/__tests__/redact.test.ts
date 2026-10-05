/**
 * P0-10 T2: redaction layer strips known secret patterns from log payloads.
 */
import { describe, expect, it } from 'vitest';
import { redact } from '../redact.js';

describe('redact', () => {
  it('strips a Bearer token out of a header-shaped string', () => {
    const out = redact('Authorization: Bearer abc123.XYZ-token_value==') as string;
    expect(out).not.toContain('abc123');
    expect(out).toContain('[REDACTED]');
  });

  it('strips an AWS access key id', () => {
    const out = redact('key_id=AKIAIOSFODNN7EXAMPLE') as string;
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('strips a JWT, all three segments', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redact(`token=${jwt}`) as string;
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('eyJ'); // not even a fragment of the header segment
  });

  it('strips a PEM private key block in its entirety', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----';
    const out = redact(`cert: ${pem}`) as string;
    expect(out).not.toContain('MIIBOgIBAAJBAK');
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('strips a password field, keeping the field name visible', () => {
    const out = redact('password: "sup3rSecret!"') as string;
    expect(out).not.toContain('sup3rSecret');
    expect(out).toContain('password');
  });

  it('strips an api_key field written with = instead of :', () => {
    const out = redact('api_key=sk_live_abc123XYZ') as string;
    expect(out).not.toContain('sk_live_abc123XYZ');
  });

  it('walks nested objects and arrays, not just top-level strings', () => {
    const out = redact({
      user: { email: 'a@example.com', password: 'hunter2hunter2' },
      headers: ['Authorization: Bearer leaked-token-value-here'],
    }) as { user: { email: string } };
    expect(JSON.stringify(out)).not.toContain('hunter2hunter2');
    expect(JSON.stringify(out)).not.toContain('leaked-token-value-here');
    // Non-secret data survives untouched.
    expect(out.user.email).toBe('a@example.com');
  });

  it('does not touch ordinary, non-secret-shaped text', () => {
    const benign = { action: 'case.viewed', tenantId: 'abc-123', count: 42 };
    expect(redact(benign)).toEqual(benign);
  });

  it('does not false-positive on an ordinary dotted version string', () => {
    // A JWT-looking regex that fired on "1.2.3" would be a false positive
    // this specific pattern is designed to avoid (it requires a JWT-shaped
    // header segment starting with "eyJ").
    expect(redact('schemaVersion=1.2.3')).toBe('schemaVersion=1.2.3');
  });

  it('is depth-limited against pathological nesting rather than recursing forever', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 50; i++) deep = { child: deep };
    expect(() => redact(deep)).not.toThrow();
  });
});
