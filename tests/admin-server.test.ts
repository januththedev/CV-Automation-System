import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../src/contracts.js';
import * as database from '../src/database/db.js';
import { createAdminServer, startAdminRuntime } from '../api/admin-server.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://127.0.0.1:3001';
const config: AppConfig = {
  deviceName: 'test-device', dataDir: 'unused', configDir: 'unused', logDir: 'unused',
  sessionTimeoutMinutes: 30, redisUrl: 'redis://invalid.invalid:1', apiPort: 0,
  adminWhatsappNumber: '947700000001', dashboardUrl: null, mandatoryFields: ['name'],
  whatsapp: { accessToken: 'PRIVATE', phoneNumberId: 'phone', wabaId: 'waba', verifyToken: 'PRIVATE', appSecret: 'PRIVATE' },
  onedrive: { clientId: 'PRIVATE', folderRoot: 'CV Applications', tokenCachePath: 'PRIVATE' },
  sheets: { serviceAccountEmail: 'PRIVATE', privateKey: 'PRIVATE', sheetId: 'sheet' },
  openrouter: { apiKey: 'PRIVATE', model: 'google/gemini-3.8-flash' },
};

let app: FastifyInstance | undefined;
let conn: ReturnType<typeof database.getDb>;
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-admin-'));
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
function build(cfg: AppConfig = config, token = TOKEN) {
  app = createAdminServer(cfg, conn, { adminToken: token, allowedOrigin: ORIGIN });
  return app;
}
function get(url: string, token: string | undefined = TOKEN, origin?: string) {
  return app!.inject({
    method: 'GET', url,
    headers: {
      host: '127.0.0.1:3001',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(origin === undefined ? {} : { origin }),
    },
  });
}
function addApplication(overrides: Partial<database.CreateApplicationInput> = {}) {
  return database.createApplication({
    whatsapp_jid: '94771234567@s.whatsapp.net',
    whatsapp_number: '94771234567',
    name: 'Candid Ate', nic: '912345678V', address: '12 Private Lane',
    cv_phone_number: '0771234567', profession: 'Tech',
    cv_local_path: path.join(dir, 'cv.pdf'),
    ...overrides,
  });
}

describe('admin auth boundary', () => {
  it.each([undefined, '', 'Bearer', 'Bearer wrong', `Bearer ${TOKEN} `, `Basic ${TOKEN}`, TOKEN])(
    'rejects missing or malformed bearer %j', async (auth) => {
      await build();
      const res = await app!.inject({
        method: 'GET', url: '/admin/api/stats',
        headers: { host: '127.0.0.1:3001', ...(auth === undefined ? {} : { authorization: auth }) },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
    });

  it('rejects a token differing only after constant-time compare', async () => {
    await build(config, '0123456789abcdef0123456789abcdeX');
    expect((await get('/admin/stats', TOKEN)).statusCode).toBe(401);
  });

  it('never accepts the token via query string', async () => {
    await build();
    const res = await app!.inject({ url: `/admin/stats?token=${TOKEN}`, headers: { host: '127.0.0.1:3001' } });
    expect(res.statusCode).toBe(401);
  });

  it('sends no CORS or permissive headers and disables Fastify request logging', async () => {
    await build();
    const ok = await get('/admin/stats');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBeUndefined();
    const missing = await get('/admin/stats', 'wrong');
    expect(missing.statusCode).toBe(401);
    expect((app!.log as { level?: unknown }).level).toBeUndefined();
  });

  it('requires same-origin for browser Origin-bearing requests', async () => {
    await build();
    expect((await get('/admin/stats', TOKEN, ORIGIN)).statusCode).toBe(200);
    expect((await get('/admin/stats', TOKEN, 'http://evil.example')).statusCode).toBe(403);
    expect((await get('/admin/stats', TOKEN, 'null')).statusCode).toBe(403);
  });

  it('serves the same-origin dashboard shell and assets without serving arbitrary files', async () => {
    await build();
    const shell = await get('/admin/dashboard');
    expect(shell.statusCode).toBe(200);
    expect(shell.headers['content-type']).toContain('text/html');
    expect(shell.body).toContain('id="admin-token"');
    expect(shell.body).not.toContain(TOKEN);
    const script = await get('/admin/dashboard/app.js');
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');
    for (const bad of ['/admin/dashboard/../config.json', '/admin/dashboard/..%2Fconfig.json',
      '/admin/dashboard/%2e%2e%2fconfig.json', '/admin/dashboard/sub/../../x']) {
      const res = await get(bad);
      expect([400, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain('PRIVATE');
    }
  });
});

describe('admin data routes', () => {
  it('returns paginated applications with sanitized allowlisted fields only', async () => {
    await build();
    addApplication();
    const res = await get('/admin/applications?limit=50&offset=0');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.applications).toHaveLength(1);
    expect(Object.keys(body.applications[0]).sort()).toEqual([
      'created_at', 'cv_phone_number', 'id', 'review',
      'status', 'updated_at', 'whatsapp_number',
    ]);
    expect(body.applications[0].whatsapp_number).toBe('94771234567');
    expect(body.applications[0].cv_phone_number).toBe('0771234567');
    expect(JSON.stringify(body)).not.toContain('Candid Ate');
    expect(JSON.stringify(body)).not.toContain('912345678V');
    expect(body.applications[0].review).toBe(false);
    expect(JSON.stringify(body)).not.toContain('PRIVATE');
    expect(JSON.stringify(body)).not.toContain('cv.pdf');
  });

  it('clamps pagination bounds and filters by status', async () => {
    await build();
    addApplication();
    addApplication({ status: 'COMPLETED' });
    expect((await get('/admin/applications?limit=0')).json().applications).toHaveLength(1);
    expect((await get('/admin/applications?limit=99999')).json().applications).toHaveLength(2);
    expect((await get('/admin/applications?offset=-5')).json().applications).toHaveLength(2);
    expect((await get('/admin/applications?status=COMPLETED')).json().total).toBe(1);
    expect((await get('/admin/applications?status=NOT_A_STATUS')).statusCode).toBe(400);
  });

  it('returns sanitized stats', async () => {
    await build();
    addApplication({ status: 'COMPLETED' });
    const res = await get('/admin/stats');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.byStatus.COMPLETED).toBe(1);
    expect(body.last24h).toBe(1);
    expect(Object.keys(body).sort()).toEqual(['byStatus', 'last24h', 'total']);
  });

  it('reports configured provider indicators as configured/unconfigured only', async () => {
    await build();
    const res = await get('/admin/services');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      providers: {
        openrouter: { configured: true },
        whatsapp: { configured: true },
        onedrive: { configured: true },
        sheets: { configured: true },
      },
    });
    await build({ ...config, openrouter: null, whatsapp: null, onedrive: null, sheets: null });
    const none = await get('/admin/services');
    expect(none.json()).toEqual({
      providers: {
        openrouter: { configured: false },
        whatsapp: { configured: false },
        onedrive: { configured: false },
        sheets: { configured: false },
      },
    });
  });

  it('exposes no write verbs, no shell/AI/model routes, and serves no dashboard files', async () => {
    await build();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app!.inject({ method, url: '/admin/stats',
        headers: { host: '127.0.0.1:3001', authorization: `Bearer ${TOKEN}` } });
      expect([404, 405]).toContain(res.statusCode);
    }
    for (const url of ['/admin/model', '/admin/ai', '/admin/exec', '/admin/shell', '/admin/restart',
      '/admin', '/admin/', '/admin/../secret', '/admin/index.html']) {
      const res = await get(url);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('PRIVATE');
    }
  });

  it('returns generic errors without echoing filesystem paths or raw DB errors', async () => {
    await build();
    await get('/admin/stats');
    database.closeDb();
    const res = await get('/admin/stats');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
    expect(res.body).not.toContain(dir);
    expect(res.body).not.toContain('PRIVATE');
  });
});

describe('admin runtime', () => {
  it('requires CV_ADMIN_TOKEN, binds loopback only, and stops idempotently', async () => {
    vi.stubEnv('CV_ADMIN_TOKEN', 'runtime-admin-token-0123456789');
    const before = process.listenerCount('SIGINT');
    const runtime = await startAdminRuntime({ config: { ...config, dataDir: dir }, port: 0 });
    try {
      expect(runtime.server.server.address()).toMatchObject({ address: '127.0.0.1' });
      const res = await runtime.server.inject({ method: 'GET', url: '/admin/stats',
        headers: { host: `127.0.0.1:${(runtime.server.server.address() as { port: number }).port}`, authorization: 'Bearer runtime-admin-token-0123456789' } });
      expect(res.statusCode).toBe(200);
    } finally { await Promise.all([runtime.stop(), runtime.stop()]); }
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('fails closed when CV_ADMIN_TOKEN is missing or trivially weak', async () => {
    vi.stubEnv('CV_ADMIN_TOKEN', '');
    await expect(startAdminRuntime({ config: { ...config, dataDir: dir } })).rejects.toThrow();
    vi.stubEnv('CV_ADMIN_TOKEN', 'short');
    await expect(startAdminRuntime({ config: { ...config, dataDir: dir } })).rejects.toThrow();
  });

  it('opens the database read-only for status without creating a schema', async () => {
    // Admin status tooling must never CREATE tables on an existing database.
    const { getReadonlyStatus } = await import('../api/admin-server.js');
    const status = getReadonlyStatus(path.join(dir, 'applications.db'));
    expect(status).not.toBeNull();
    expect(status!.schemaReady).toBe(true);
    database.closeDb();
    const missing = getReadonlyStatus(path.join(dir, 'absent.db'));
    expect(missing).toBeNull();
    expect(fs.existsSync(path.join(dir, 'absent.db'))).toBe(false);
  });
});
