import { timingSafeEqual } from 'node:crypto';
import type { InboundMessage, WhatsAppClientApi, WhatsAppConfig } from '../../contracts.js';
import { assertPublicHttpUrl } from '../../network/url-guard.js';

const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;

function graphBase(cfg: WhatsAppConfig): string {
  const version = cfg.apiVersion ?? 'v21.0';
  if (!/^v\d+\.\d+$/.test(version)) throw new Error('Invalid WhatsApp API version');
  return `https://graph.facebook.com/${version}`;
}

/** Bounds fetch AND body consumption. Never include response bodies or tokens in errors. */
async function request<T>(cfg: WhatsAppConfig, url: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
  // Every outbound URL (including provider-supplied media URLs) must pass the
  // host guard BEFORE the bearer token is attached and before any request.
  await assertPublicHttpUrl(url);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let retryDelay = 500 * 2 ** attempt;
    try {
      const response = await fetch(url, { ...init, redirect: 'error', headers: { ...init.headers, Authorization: `Bearer ${cfg.accessToken}` }, signal: controller.signal });
      if (response.ok) return await consume(response);
      const retryable = response.status === 429 || response.status >= 500;
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(delay)) retryDelay = Math.min(30_000, Math.max(retryDelay, delay));
      }
      await response.body?.cancel();
      if (!retryable || attempt === MAX_ATTEMPTS - 1) throw new HttpError(response.status);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Do not retry ambiguous POST transport failures, which could duplicate a sent message.
      throw new Error(controller.signal.aborted ? 'WhatsApp request timed out' : 'WhatsApp request failed');
    } finally {
      clearTimeout(timer);
    }
    await new Promise(resolve => setTimeout(resolve, retryDelay));
  }
  throw new Error('WhatsApp request failed');
}
class HttpError extends Error {
  constructor(status: number) { super(`WhatsApp API HTTP ${status}`); }
}

function senderDigits(value: string): string | null {
  const parts = value.trim().split('@');
  if (parts.length > 2 || (parts.length === 2 && !['s.whatsapp.net', 'c.us'].includes(parts[1]))) return null;
  const local = parts[0].replace(/:\d+$/, '');
  if (!/^\+?[\d\s().-]+$/.test(local)) return null;
  const digits = local.replace(/\D/g, '');
  return /^[1-9]\d{5,14}$/.test(digits) ? digits : null;
}

export class WhatsAppClient implements WhatsAppClientApi {
  private readonly cfg: WhatsAppConfig;
  constructor(cfg: WhatsAppConfig) { this.cfg = { ...cfg }; }
  private async post(body: object): Promise<void> {
    await request(this.cfg, `${graphBase(this.cfg)}/${encodeURIComponent(this.cfg.phoneNumberId)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, async response => { await response.arrayBuffer(); });
  }
  async sendText(to: string, text: string): Promise<void> {
    const number = senderDigits(to);
    if (!number) throw new Error('Invalid WhatsApp recipient');
    await this.post({ messaging_product: 'whatsapp', recipient_type: 'individual', to: number, type: 'text', text: { preview_url: false, body: text } });
  }
  async markRead(messageId: string): Promise<void> {
    await this.post({ messaging_product: 'whatsapp', status: 'read', message_id: messageId });
  }
  verifyWebhook(hubMode: unknown, hubVerifyToken: unknown): boolean {
    return verifyWebhook(hubMode, hubVerifyToken, this.cfg.verifyToken);
  }
}

/** GET handshake only; POST webhook HMAC authentication belongs at the API boundary. */
export function verifyWebhook(hubMode: unknown, hubVerifyToken: unknown, expectedToken: string): boolean {
  if (hubMode !== 'subscribe' || typeof hubVerifyToken !== 'string' || !expectedToken) return false;
  const actual = Buffer.from(hubVerifyToken);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function downloadMedia(cfg: WhatsAppConfig, mediaId: string): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
  const metadata = await request(cfg, `${graphBase(cfg)}/${encodeURIComponent(mediaId)}`, { method: 'GET' }, response => response.json()) as Record<string, unknown>;
  let url: URL;
  try { url = new URL(String(metadata.url)); } catch { throw new Error('Invalid WhatsApp media URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid WhatsApp media URL');
  const media = await request(cfg, url.href, { method: 'GET' }, async response => ({ buffer: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') }));
  const mimeType = typeof metadata.mime_type === 'string' ? metadata.mime_type : media.contentType?.split(';')[0] ?? 'application/octet-stream';
  const extensions: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx' };
  const raw = typeof metadata.filename === 'string' ? metadata.filename.split(/[\\/]/).pop()! : '';
  const filename = raw.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').slice(0, 200);
  return { buffer: media.buffer, filename: filename && !/^\.+$/.test(filename) ? filename : `media.${extensions[mimeType] ?? 'bin'}`, mimeType };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string | null { return typeof value === 'string' ? value : null; }

/** Pure parser. Identity comes ONLY from messages[].from, never content, contacts or AI. */
export function parseWebhookPayload(payload: unknown): InboundMessage[] {
  const result: InboundMessage[] = [];
  for (const entry of list(record(payload).entry)) {
    for (const change of list(record(entry).changes)) {
      if (record(change).field !== 'messages') continue;
      for (const raw of list(record(record(change).value).messages)) {
        const message = record(raw);
        const type = message.type;
        if (type !== 'text' && type !== 'document' && type !== 'image' && type !== 'audio' && type !== 'video') continue;
        const from = string(message.from);
        const digits = from ? senderDigits(from) : null;
        const id = string(message.id);
        const seconds = typeof message.timestamp === 'string' && /^\d+$/.test(message.timestamp) ? Number(message.timestamp) : NaN;
        const date = new Date(seconds * 1000);
        if (!digits || !id || !Number.isFinite(date.getTime())) continue;
        const content = record(message[type]);
        if (type === 'text' ? typeof content.body !== 'string' : !string(content.id)) continue;
        result.push({ wa_message_id: id, from_jid: `${digits}@s.whatsapp.net`, from_number: `+${digits}`, timestamp: date.toISOString(), type, text: string(type === 'text' ? content.body : content.caption), media_id: type === 'text' ? null : string(content.id), media_mime_type: type === 'text' ? null : string(content.mime_type), media_filename: type === 'text' ? null : string(content.filename) });
      }
    }
  }
  return result;
}
