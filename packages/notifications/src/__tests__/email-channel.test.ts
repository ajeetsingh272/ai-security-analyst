/**
 * Unit tests against a mocked `fetch` — proves the request this
 * channel builds (both html AND text always present, opt-out
 * short-circuit, failure surfacing, domain-verification parsing).
 * Never calls the real Resend API: no API key or verified sending
 * domain exists in this environment (see email-channel.ts's own doc
 * comment) — T1 ("passing authentication checks") is honestly
 * un-exercised, not faked here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEmailChannel, checkDomainVerification, EmailRecipientOptedOutError } from '../channels/email-channel.js';
import type { OptoutChecker } from '../types.js';

const config = { apiKey: 're_test_key', apiBaseUrl: 'https://example.invalid' };

function neverOptedOut(): OptoutChecker {
  return { isOptedOut: async () => false };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Email channel', () => {
  it('sends with both html and text always present (AC5)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'email_123' }) });
    vi.stubGlobal('fetch', fetchMock);

    const channel = buildEmailChannel(config, neverOptedOut());
    await channel.send('tenant-1', { to: 'owner@example.com', from: 'alerts@sentinel.example', subject: 'Critical alert', html: '<p>hi</p>', text: 'hi' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.invalid/emails');
    expect(init.headers.Authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(init.body);
    expect(body.html).toBe('<p>hi</p>');
    expect(body.text).toBe('hi');
  });

  it('T4 (shared with WhatsApp AC): an opted-out (or hard-bounced) recipient is never sent to', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const optedOut: OptoutChecker = { isOptedOut: async () => true };

    const channel = buildEmailChannel(config, optedOut);
    await expect(channel.send('tenant-1', { to: 'bounced@example.com', from: 'x@sentinel.example', subject: 'x', html: '<p/>', text: 'x' })).rejects.toThrow(EmailRecipientOptedOutError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a Resend API error as a thrown error, not a silent success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ message: 'Invalid `to` field' }) });
    vi.stubGlobal('fetch', fetchMock);

    const channel = buildEmailChannel(config, neverOptedOut());
    await expect(channel.send('tenant-1', { to: 'bad', from: 'x@sentinel.example', subject: 'x', html: '<p/>', text: 'x' })).rejects.toThrow('Invalid `to` field');
  });
});

describe('checkDomainVerification (AC1)', () => {
  it('reports SPF/DKIM/DMARC status independently', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'verified',
        records: [
          { record: 'SPF', status: 'verified' },
          { record: 'DKIM', status: 'verified' },
          { record: 'DMARC', status: 'pending' },
          { record: 'MX', status: 'verified' }, // not an auth record — must be filtered out
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkDomainVerification(config, 'domain_123');
    expect(result.status).toBe('verified');
    expect(result.records).toEqual([
      { type: 'SPF', status: 'verified' },
      { type: 'DKIM', status: 'verified' },
      { type: 'DMARC', status: 'pending' },
    ]);
  });

  it('throws on an HTTP-level failure rather than returning a misleading result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);
    await expect(checkDomainVerification(config, 'nonexistent')).rejects.toThrow('Resend domain lookup failed (404)');
  });
});
