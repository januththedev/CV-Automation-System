import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../src/contracts.js';
import * as database from '../src/database/db.js';
import { createApiServer } from '../api/server.js';

// Dummy values assembled at runtime: no usable credential literals in tests.
const token = (label: string) => ['local', 'test', label].join('-');
const secret = token('secret');
const config: AppConfig = {
  deviceName: 'test', dataDir: 'unused', configDir: 'unused', logDir: 'unused',
  sessionTimeoutMinutes: 30, redisUrl: 'redis://invalid.invalid:1', apiPort: 0,
  adminWhatsappNumber: null, dashboardUrl: null, mandatoryFields: ['name'],
  whatsapp: { accessToken: token('access'), phoneNumberId: 'phone', wabaId: 'waba', verifyToken: token('verify'), appSecret: secret },
  onedrive: null, sheets: null, openrouter: null,
};
const message = (id = 'wamid.1', from = '94771234567') => ({
  id, from, timestamp: '1789632000', type: 'text', text: { body: 'Private candidate café' },
});
const payload = (messages = [message()]) => Buffer.from(JSON.stringify({
  object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages } }] }],
}, null, 2) + '\n');
const signature = (body: Buffer) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

let app: FastifyInstance | undefined;
let conn: ReturnType<typeof database.getDb>;
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-api-'));
  conn = database.getDb(path.join(dir, 'applications.db'));
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  database.closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function build(cfg = config) {
  app = createApiServer(cfg, conn);
  return app;
}
async function post(body = payload(), sig: string | undefined = signature(body)) {
  return app!.inject({ method: 'POST', url: '/webhook', payload: body,
    headers: { 'content-type': 'application/json', ...(sig === undefined ? {} : { 'x-hub-signature-256': sig }) } });
}
function counts() {
  return ['applications', 'messages', 'sessions', 'pending_work'].map(table =>
    (conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}
function snapshot() {
  return ['applications', 'messages', 'sessions', 'pending_work', 'counters'].map(table =>
    conn.prepare(`SELECT * FROM ${table}`).all());
}

describe('bounded webhook API', () => {
  it('persists original signed bytes, session and pending work before ACK, without publishing', async () => {
    await build();
    const result = await post();
    expect(result.statusCode).toBe(200);
    expect(counts()).toEqual([1, 1, 1, 1]);
    expect(conn.inTransaction).toBe(false);
    const observer = new (await import('better-sqlite3')).default(path.join(dir, 'applications.db'), { readonly: true });
    try { expect(observer.prepare('SELECT text FROM messages').get()).toEqual({ text: 'Private candidate café' }); }
    finally { observer.close(); }
    expect(database.listPendingWork()[0].dispatched_at).toBeNull();
    expect(database.getSession('+94771234567')?.greeting_sent).toBe(false);
  });

  it('treats candidate URLs as text without outbound network access', async () => {
    await build();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network access'));
    const text = 'My portfolio is https://portfolio.example.invalid/cv';
    const body = payload([{ ...message(), text: { body: text } }]);
    expect((await post(body)).statusCode).toBe(200);
    expect(conn.prepare('SELECT text FROM messages').get()).toEqual({ text });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('makes duplicate receipts a complete no-op', async () => {
    await build();
    expect((await post()).statusCode).toBe(200);
    const before = snapshot();
    expect((await post()).statusCode).toBe(200);
    expect(snapshot()).toEqual(before);
  });

  it('commits all messages in a batch', async () => {
    await build();
    expect((await post(payload([message(), message('wamid.2'), message('wamid.3', '94779876543')]))).statusCode).toBe(200);
    expect(counts()).toEqual([2, 3, 2, 3]);
    expect(database.listApplications().map(a => a.revision).sort()).toEqual([1, 2]);
  });

  it('rolls back the entire batch on a later SQLite failure and allows retry', async () => {
    await build();
    conn.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON pending_work
      WHEN NEW.wa_message_id = 'wamid.2' BEGIN SELECT RAISE(ABORT, 'PRIVATE database failure'); END;`);
    const before = snapshot();
    const body = payload([message(), message('wamid.2')]);
    const result = await post(body);
    expect(result.statusCode).toBe(500);
    expect(result.json()).toEqual({ error: 'Internal Server Error' });
    expect(snapshot()).toEqual(before);
    expect(conn.inTransaction).toBe(false);
    conn.exec('DROP TRIGGER fail_second');
    expect((await post(body)).statusCode).toBe(200);
    expect(counts()).toEqual([1, 2, 1, 2]);
  });

  it('rejects a tampered body before ingestion', async () => {
    await build();
    const original = payload();
    const result = await post(Buffer.concat([original, Buffer.from(' ')]), signature(original));
    expect(result.statusCode).toBe(403);
    expect(result.json()).toEqual({ error: 'Forbidden' });
    expect(counts()).toEqual([0, 0, 0, 0]);
  });

  it.each(['', 'sha256=bad', `sha1=${'0'.repeat(64)}`, `sha256=${'g'.repeat(64)}`, `sha256=${'0'.repeat(64)}`, `sha256=${'0'.repeat(66)}`])('rejects malformed or wrong signature %s', async sig => {
    await build();
    expect((await post(payload(), sig)).statusCode).toBe(403);
    expect(counts()).toEqual([0, 0, 0, 0]);
  });

  it('rejects missing signature even when JSON is invalid', async () => {
    await build();
    const result = await app!.inject({ method: 'POST', url: '/webhook', payload: '{private', headers: { 'content-type': 'application/json' } });
    expect(result.statusCode).toBe(403);
    expect(counts()).toEqual([0, 0, 0, 0]);
  });

  it.each([null, { ...config.whatsapp!, appSecret: undefined }, { ...config.whatsapp!, appSecret: '' }])('fails closed when POST authentication is unconfigured', async whatsapp => {
    await build({ ...config, whatsapp });
    const result = await post();
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ error: 'Service Unavailable' });
    expect(counts()).toEqual([0, 0, 0, 0]);
  });

  it('parses JSON only after successful signature verification', async () => {
    await build();
    const result = await post(Buffer.from('{"private":'));
    expect(result.statusCode).toBe(400);
    expect(result.json()).toEqual({ error: 'Bad Request' });
    expect(counts()).toEqual([0, 0, 0, 0]);
  });

  it('ACKs signed status notifications without creating work', async () => {
    await build();
    const body = Buffer.from(JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'status-only', status: 'delivered' }] } }] }] }));
    expect((await post(body)).statusCode).toBe(200);
    expect(counts()).toEqual([0, 0, 0, 0]);
  });

  it('enforces the 1 MiB original-byte limit', async () => {
    await build();
    const exact = Buffer.from('{}' + ' '.repeat(1024 * 1024 - 2));
    expect((await post(exact)).statusCode).toBe(200);
    const result = await post(Buffer.concat([exact, Buffer.from(' ')]));
    expect(result.statusCode).toBe(413);
    expect(result.json()).toEqual({ error: 'Payload Too Large' });
    expect(counts()).toEqual([0, 0, 0, 0]);
  });

  it('verifies handshake and returns a plain-text challenge', async () => {
    await build();
    const result = await app!.inject({ url: '/webhook', query: {
      'hub.mode': 'subscribe', 'hub.verify_token': config.whatsapp!.verifyToken, 'hub.challenge': '001234',
    } });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('001234');
    expect(result.headers['content-type']).toContain('text/plain');
  });

  it.each<Record<string, string>>([
    { 'hub.mode': 'wrong', 'hub.verify_token': config.whatsapp!.verifyToken, 'hub.challenge': '1' },
    { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' },
    { 'hub.mode': 'subscribe', 'hub.verify_token': config.whatsapp!.verifyToken },
    { 'hub.mode': 'subscribe', 'hub.verify_token': config.whatsapp!.verifyToken, 'hub.challenge': '' },
  ])('rejects incomplete or incorrect handshake', async query => {
    await build();
    const result = await app!.inject({ url: '/webhook', query });
    expect(result.statusCode).toBe(403);
    expect(result.json()).toEqual({ error: 'Forbidden' });
  });

  it('fails closed for an unconfigured handshake', async () => {
    await build({ ...config, whatsapp: null });
    expect((await app!.inject('/webhook')).statusCode).toBe(503);
  });

  it('health checks only SQLite SELECT 1 and exposes no candidate data', async () => {
    await build();
    await post();
    const prepare = vi.spyOn(conn, 'prepare');
    const result = await app!.inject('/health');
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ sqlite: 'ok' });
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns a generic unavailable health response for a closed DB without reopening it', async () => {
    await build();
    database.closeDb();
    const result = await app!.inject('/health');
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ error: 'Service Unavailable' });
    expect(conn.open).toBe(false);
  });

  it('does not close the caller-owned DB when closing the factory server', async () => {
    await build();
    await app!.close();
    expect(conn.open).toBe(true);
  });

  it('has no public admin/data/model routes or URL-reflecting errors', async () => {
    await build();
    for (const url of ['/admin', '/applications', '/data', '/models', '/private?token=PRIVATE']) {
      const result = await app!.inject(url);
      expect(result.statusCode).toBe(404);
      expect(result.json()).toEqual({ error: 'Not Found' });
    }
    // logger:false — Fastify exposes only a noop placeholder, no pino level.
    expect((app!.log as { level?: unknown }).level).toBeUndefined();
  });
});

describe('API runtime', () => {
  it('pins the database path, listens on loopback, and stops idempotently', async () => {
    const { startApiRuntime } = await import('../api/server.js');
    vi.stubEnv('SQLITE_PATH', path.join(dir, 'wrong.db'));
    vi.stubEnv('CV_API_HOST', '127.0.0.1');
    const before = process.listenerCount('SIGTERM');
    const runtime = await startApiRuntime({ config: { ...config, dataDir: dir } });
    try {
      expect(runtime.server.server.address()).toMatchObject({ address: '127.0.0.1' });
      expect((await runtime.server.inject('/health')).statusCode).toBe(200);
      expect(conn.name).toBe(path.join(dir, 'applications.db'));
      expect(fs.existsSync(path.join(dir, 'wrong.db'))).toBe(false);
      expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    } finally { await Promise.all([runtime.stop(), runtime.stop()]); }
    expect(conn.open).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('closes SQLite and removes handlers on listen failure', async () => {
    const { startApiRuntime } = await import('../api/server.js');
    const before = process.listenerCount('SIGTERM');
    await expect(startApiRuntime({ config: { ...config, dataDir: dir, apiPort: -1 } }))
      .rejects.toThrow();
    expect(conn.open).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});

it('imports server and runtime without config/DB/logger/network I/O or signal registration', async () => {
  vi.resetModules();
  const configModule = await import('../src/config.js');
  const dbModule = await import('../src/database/db.js');
  const load = vi.spyOn(configModule, 'loadConfig');
  const open = vi.spyOn(dbModule, 'getDb');
  const mkdir = vi.spyOn(fs, 'mkdirSync');
  const on = vi.spyOn(process, 'on');
  const fetch = vi.spyOn(globalThis, 'fetch');
  vi.doMock('../src/logger.js', () => { throw new Error('Logger must remain lazy'); });
  try {
    const server = await import('../api/server.js');
    const runtime = await import('../api/index.js');
    expect(server.createApiServer).toBeTypeOf('function');
    expect(runtime.startApiRuntime).toBeTypeOf('function');
    expect(load).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.doUnmock('../src/logger.js'); }
});
