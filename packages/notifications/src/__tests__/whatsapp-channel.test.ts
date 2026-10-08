/**
 * Unit tests against a mocked `fetch` — proves the request this channel
 * BUILDS (template/button shape, opt-out short-circuit, template-rejection
 * detection) is correct. Never calls the real Meta Graph API: no sandbox
 * credentials exist in this environment (see whatsapp-channel.ts's own
 * doc comment) — T1 ("delivered against the sandbox") is honestly
 * un-exercised, not faked here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@sentinel/observability';
import { buildWhatsAppChannel, RecipientOptedOutError } from '../channels/whatsapp-channel.js';
import type { OptoutChecker } from '../types.js';

const logger = createLogger({ service: 'whatsapp-test' });
const TENANT = '22222222-2222-2222-2222-222222222222';
const config = { phoneNumberId: '1234567890', accessToken: 'test-token', apiBaseUrl: 'https://example.invalid/v20.0' };

function neverOptedOut(): OptoutChecker {
  return { isOptedOut: async () => false };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WhatsApp channel', () => {
  it('sends a template message with approve/call-me-first/opt-out buttons for an action alert', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const channel = buildWhatsAppChannel(config, neverOptedOut(), logger);
    await channel.send(TENANT, {
      recipientPhone: '15551234567',
      templateName: 'sentinel_critical_alert',
      languageCode: 'en_US',
      bodyParams: ['Priya', 'Russia', 'fraud preparation'],
      actionId: 'action-1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.invalid/v20.0/1234567890/messages');
    expect(requestInit.headers.Authorization).toBe('Bearer test-token');

    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.to).toBe('15551234567');
    expect(sentBody.template.name).toBe('sentinel_critical_alert');
    const buttonComponents = sentBody.template.components.filter((c: { type: string }) => c.type === 'button');
    expect(buttonComponents).toHaveLength(3);
    expect(buttonComponents[0].parameters[0].payload).toBe(`approve:${TENANT}:action-1`);
    expect(buttonComponents[1].parameters[0].payload).toBe(`call_me_first:${TENANT}:action-1`);
    expect(buttonComponents[2].parameters[0].payload).toBe(`optout:${TENANT}`);
  });

  it('a digest template with no action carries only the opt-out button', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const channel = buildWhatsAppChannel(config, neverOptedOut(), logger);
    await channel.send(TENANT, { recipientPhone: '15551234567', templateName: 'sentinel_daily_digest', languageCode: 'en_US', bodyParams: ['3 cases today'] });

    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
    const buttonComponents = sentBody.template.components.filter((c: { type: string }) => c.type === 'button');
    expect(buttonComponents).toHaveLength(1);
    expect(buttonComponents[0].parameters[0].payload).toBe(`optout:${TENANT}`);
  });

  it('T4: an opted-out recipient is never sent to, and the failure says why', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const optedOut: OptoutChecker = { isOptedOut: async () => true };

    const channel = buildWhatsAppChannel(config, optedOut, logger);
    await expect(
      channel.send(TENANT, { recipientPhone: '15551234567', templateName: 'sentinel_daily_digest', languageCode: 'en_US', bodyParams: ['x'] }),
    ).rejects.toThrow(RecipientOptedOutError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AC5: a template-rejection error from Meta is logged as an operational page, distinct from a generic failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Number of parameters does not match', code: 132000 } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const channel = buildWhatsAppChannel(config, neverOptedOut(), logger);
    await expect(
      channel.send(TENANT, { recipientPhone: '15551234567', templateName: 'sentinel_daily_digest', languageCode: 'en_US', bodyParams: ['x'] }),
    ).rejects.toThrow('WhatsApp send failed (400)');

    expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ page: true, meta_error_code: 132000 }), expect.stringContaining('template rejected'));
    errorSpy.mockRestore();
  });

  it('a generic transport failure is surfaced without the template-rejection page log', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: { message: 'internal error', code: 1 } }) });
    vi.stubGlobal('fetch', fetchMock);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const channel = buildWhatsAppChannel(config, neverOptedOut(), logger);
    await expect(
      channel.send(TENANT, { recipientPhone: '15551234567', templateName: 'sentinel_daily_digest', languageCode: 'en_US', bodyParams: ['x'] }),
    ).rejects.toThrow('WhatsApp send failed (500)');

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('refuses to render an action template with no actionId rather than send a broken button', async () => {
    const channel = buildWhatsAppChannel(config, neverOptedOut(), logger);
    await expect(
      channel.send(TENANT, { recipientPhone: '15551234567', templateName: 'sentinel_critical_alert', languageCode: 'en_US', bodyParams: ['a', 'b', 'c'] }),
    ).rejects.toThrow('requires an actionId');
  });
});
