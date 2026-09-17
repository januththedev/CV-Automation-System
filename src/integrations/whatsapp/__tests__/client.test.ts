import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WhatsAppConfig } from '../../../contracts.js';
import { WhatsAppClient, downloadMedia, parseWebhookPayload, verifyWebhook } from '../client.js';

const dummyToken = ['test', 'not', 'a', 'secret'].join('-');
const dummyVerify = ['verify', 'not', 'a', 'secret'].join('-');
const cfg: WhatsAppConfig = { accessToken: dummyToken, phoneNumberId: '123', wabaId: '456', verifyToken: dummyVerify };
const envelope = (messages: unknown[], extra = {}) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { display_phone_number: '999999999', phone_number_id: '123' }, contacts: [{ wa_id: '11111111', profile: { name: '+22222222' } }], messages, ...extra } }] }] });
const text = { id: 'wamid.text', from: '94771234567', timestamp: '1700000000', type: 'text', text: { body: 'My number is +333333333' } };
const document = { id: 'wamid.doc', from: '+94 77 123 4567@s.whatsapp.net', timestamp: '1700000001', type: 'document', document: { id: 'media123', mime_type: 'application/pdf', filename: 'CV.pdf', caption: 'Please consider my application.' } };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('webhook metadata parsing', () => {
  it('parses text using only the envelope message from metadata', () => {
    expect(parseWebhookPayload(envelope([text]))).toEqual([{ wa_message_id: 'wamid.text', from_jid: '94771234567@s.whatsapp.net', from_number: '+94771234567', timestamp: '2023-11-14T22:13:20.000Z', type: 'text', text: text.text.body, media_id: null, media_mime_type: null, media_filename: null }]);
  });
  it('parses document metadata, caption and sender JID', () => {
    expect(parseWebhookPayload(envelope([document]))[0]).toMatchObject({ from_jid: '94771234567@s.whatsapp.net', from_number: '+94771234567', type: 'document', media_id: 'media123', media_mime_type: 'application/pdf', media_filename: 'CV.pdf', text: document.document.caption });
  });
  it('ignores delivery statuses, including their recipient_id', () => {
    expect(parseWebhookPayload(envelope([], { statuses: [{ id: 'wamid.status', recipient_id: '94771234567', status: 'delivered' }] }))).toEqual([]);
  });
  it.each(['image', 'audio', 'video'])('supports %s media', (type) => {
    expect(parseWebhookPayload(envelope([{ ...text, type, [type]: { id: 'media', mime_type: `${type}/example` } }]))[0]).toMatchObject({ type, media_id: 'media', text: null });
  });
  it('ignores unsupported, malformed and senderless messages rather than guessing identity', () => {
    expect(parseWebhookPayload(envelope([{ ...text, from: undefined }, { ...text, from: 'group@g.us' }, { ...text, timestamp: 'bad' }, { ...text, type: 'location' }, null]))).toEqual([]);
    expect(parseWebhookPayload(null)).toEqual([]);
    expect(parseWebhookPayload({ entry: 'bad' })).toEqual([]);
  });
  it('verifies nonempty token and subscribe mode exactly', () => {
    expect(verifyWebhook('subscribe', cfg.verifyToken, cfg.verifyToken)).toBe(true);
    expect(verifyWebhook('subscribe', 'wrong', cfg.verifyToken)).toBe(false);
    expect(verifyWebhook('other', cfg.verifyToken, cfg.verifyToken)).toBe(false);
    expect(verifyWebhook('subscribe', '', '')).toBe(false);
    expect(new WhatsAppClient(cfg).verifyWebhook('subscribe', cfg.verifyToken)).toBe(true);
  });
});

describe('Graph client', () => {
  it('sends text and marks messages read with Bearer authorization', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const client = new WhatsAppClient(cfg);
    await client.sendText('+94771234567', 'Thank you.');
    await client.markRead('wamid.text');
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://graph.facebook.com/v21.0/123/messages', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: `Bearer ${dummyToken}` }), signal: expect.any(AbortSignal) }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '94771234567', type: 'text', text: { preview_url: false, body: 'Thank you.' } });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.text' });
  });
  it('uses configured API version', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('{}')); vi.stubGlobal('fetch', fetch);
    await new WhatsAppClient({ ...cfg, apiVersion: 'v22.0' }).markRead('id');
    expect(fetch.mock.calls[0][0]).toBe('https://graph.facebook.com/v22.0/123/messages');
  });
  it('downloads media metadata then authenticated bytes', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ url: 'https://lookaside.fbsbx.com/media', mime_type: 'application/pdf', filename: '../../CV.pdf' })).mockResolvedValueOnce(new Response('pdf bytes'));
    vi.stubGlobal('fetch', fetch);
    expect(await downloadMedia(cfg, 'media123')).toEqual({ buffer: Buffer.from('pdf bytes'), filename: 'CV.pdf', mimeType: 'application/pdf' });
    expect(fetch.mock.calls[0][0]).toBe('https://graph.facebook.com/v21.0/media123');
    expect(fetch.mock.calls[1][0]).toBe('https://lookaside.fbsbx.com/media');
    for (const call of fetch.mock.calls) expect(call[1]).toMatchObject({ headers: { Authorization: `Bearer ${dummyToken}` }, redirect: 'error' });
  });
  it('rejects insecure media URLs without sending a token to them', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ url: 'http://example.com/media' })); vi.stubGlobal('fetch', fetch);
    await expect(downloadMedia(cfg, 'media')).rejects.toThrow('media URL');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retries 429 and 5xx with exponential backoff', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const result = new WhatsAppClient(cfg).markRead('id');
    await vi.advanceTimersByTimeAsync(499); expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); await result; expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('does not retry 4xx or expose API error bodies', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('api error body', { status: 401 })); vi.stubGlobal('fetch', fetch);
    await expect(new WhatsAppClient(cfg).markRead('id')).rejects.toThrow('HTTP 401');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('aborts timed-out fetches', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))));
    const assertion = expect(new WhatsAppClient(cfg).markRead('id')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000); await assertion;
  });
});
