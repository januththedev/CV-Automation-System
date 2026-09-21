import fs from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import type { AppConfig, Application, ApplicationStatus } from '../src/contracts.js';
import { loadConfig } from '../src/config.js';

const STATUSES: readonly ApplicationStatus[] = [
  'RECEIVED', 'IDENTIFYING_CANDIDATE', 'WAITING_FOR_DETAILS', 'DOCUMENT_RECEIVED',
  'DOWNLOADING', 'AI_PROCESSING', 'VALIDATING', 'DUPLICATE_CHECK',
  'UPLOADING_TO_ONEDRIVE', 'CREATING_LINK', 'WRITING_TO_GOOGLE_SHEETS',
  'COMPLETED', 'NEEDS_REVIEW', 'RETRY_PENDING', 'FAILED',
];
const ASSETS = new Map([
  ['/admin/dashboard', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin/dashboard/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/admin/dashboard/app.css', ['app.css', 'text/css; charset=utf-8']],
]);

function requireAdminToken(token = process.env.CV_ADMIN_TOKEN): string {
  if (!token || !/^[A-Za-z0-9_-]{24,256}$/.test(token) || new Set(token).size < 8) {
    throw new Error('Set CV_ADMIN_TOKEN to a securely generated random token (32 random bytes recommended)');
  }
  return token;
}

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function shaped(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

type AdminRow = Pick<Application, 'id' | 'created_at' | 'updated_at' | 'whatsapp_number' | 'cv_phone_number' | 'status'> & { review: number };
function project(row: AdminRow) {
  const date = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  return {
    id: shaped(row.id, /^APP-\d{4}-\d{5,12}$/),
    created_at: shaped(row.created_at, date), updated_at: shaped(row.updated_at, date),
    whatsapp_number: shaped(row.whatsapp_number, /^\+?\d{7,15}$/),
    cv_phone_number: shaped(row.cv_phone_number, /^\+?[\d ()-]{7,24}$/),
    status: STATUSES.includes(row.status) ? row.status : 'UNKNOWN', review: row.review === 1,
  };
}

export function createAdminServer(config: AppConfig, connection: Database, options: {
  adminToken?: string; allowedOrigin?: string;
} = {}) {
  const expected = digest(requireAdminToken(options.adminToken));
  const origin = options.allowedOrigin ?? 'http://127.0.0.1:3001';
  const parsed = new URL(origin);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.origin !== origin) {
    throw new Error('Admin origin must be a loopback HTTP origin');
  }
  const app = Fastify({ logger: false, bodyLimit: 1024, exposeHeadRoutes: false });
  const expectedOrigin = () => {
    const address = app.server.address();
    return address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : origin;
  };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  });
  app.addHook('onRequest', async (request, reply) => {
    const localOrigin = expectedOrigin();
    const site = request.headers['sec-fetch-site'];
    if (request.headers.host !== new URL(localOrigin).host ||
        (request.headers.origin !== undefined && request.headers.origin !== localOrigin) ||
        (site !== undefined && site !== 'same-origin' && site !== 'none')) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const pathname = request.url.split('?')[0];
    // The shell contains no data; browser navigation cannot supply a bearer header.
    if (request.method === 'GET' && ASSETS.has(pathname) && !request.url.includes('?')) return;
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(header) : null;
    if (!timingSafeEqual(digest(match?.[1] ?? ''), expected)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });
  app.setErrorHandler((error, _request, reply) => reply.code(error.statusCode && error.statusCode < 500 ? 400 : 500)
    .send({ error: error.statusCode && error.statusCode < 500 ? 'Bad Request' : 'Internal Server Error' }));
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Not Found' }));

  for (const [url, [filename, type]] of ASSETS) {
    app.get(url, (_request, reply) => {
      const content = fs.readFileSync(new URL(`../dashboard/${filename}`, import.meta.url), 'utf8');
      return reply.type(type).send(content);
    });
  }
  app.get('/admin/applications', (request, reply) => {
    const query = request.query as Record<string, unknown>;
    if (Object.keys(query).some(key => !['limit', 'offset', 'status'].includes(key))) {
      return reply.code(400).send({ error: 'Bad Request' });
    }
    const bound = (value: unknown, fallback: number, min: number, max: number): number | null => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^-?\d{1,10}$/.test(value)) return null;
      return Math.min(max, Math.max(min, Number(value)));
    };
    const limit = bound(query.limit, 50, 1, 200);
    const offset = bound(query.offset, 0, 0, 100000);
    const status = query.status;
    if (limit === null || offset === null || (status !== undefined &&
        (typeof status !== 'string' || !STATUSES.includes(status as ApplicationStatus)))) {
      return reply.code(400).send({ error: 'Bad Request' });
    }
    const values = status === undefined ? [] : [status];
    const where = status === undefined ? '' : 'WHERE status = ?';
    return connection.transaction(() => {
      const rows = connection.prepare(`SELECT id, created_at, updated_at, whatsapp_number, cv_phone_number, status, review
        FROM applications ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...values, limit, offset) as AdminRow[];
      const total = (connection.prepare(`SELECT COUNT(*) AS n FROM applications ${where}`).get(...values) as { n: number }).n;
      return { total, applications: rows.map(project), limit, offset };
    })();
  });
  app.get('/admin/stats', (request, reply) => {
    if (request.url.includes('?')) return reply.code(400).send({ error: 'Bad Request' });
    return connection.transaction(() => {
      const byStatus: Record<string, number> = {};
      for (const status of STATUSES) byStatus[status] =
        (connection.prepare('SELECT COUNT(*) AS n FROM applications WHERE status = ?').get(status) as { n: number }).n;
      const total = (connection.prepare('SELECT COUNT(*) AS n FROM applications').get() as { n: number }).n;
      const last24h = (connection.prepare('SELECT COUNT(*) AS n FROM applications WHERE created_at >= ? AND created_at <= ?')
        .get(new Date(Date.now() - 86400000).toISOString(), new Date().toISOString()) as { n: number }).n;
      return { total, byStatus, last24h };
    })();
  });
  app.get('/admin/services', (request, reply) => {
    if (request.url.includes('?')) return reply.code(400).send({ error: 'Bad Request' });
    return { providers: {
      whatsapp: { configured: Boolean(config.whatsapp?.accessToken) },
      openrouter: { configured: Boolean(config.openrouter?.apiKey) },
      onedrive: { configured: Boolean(config.onedrive?.clientId) },
      sheets: { configured: Boolean(config.sheets?.sheetId) },
    } };
  });
  return app;
}

export interface ReadonlyStatus { schemaReady: boolean; totalApplications: number; pendingWork: number }
export function getReadonlyStatus(dbPath: string): ReadonlyStatus | null {
  let connection: Database | undefined;
  try {
    connection = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
    const schemaReady = Boolean(connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='applications'").get());
    return {
      schemaReady,
      totalApplications: schemaReady ? (connection.prepare('SELECT COUNT(*) AS n FROM applications').get() as { n: number }).n : 0,
      pendingWork: schemaReady ? (connection.prepare('SELECT COUNT(*) AS n FROM pending_work WHERE dispatched_at IS NULL').get() as { n: number }).n : 0,
    };
  } catch { return null; }
  finally { connection?.close(); }
}

export interface AdminRuntimeOptions { config?: AppConfig; configDir?: string; port?: number; registerSignals?: boolean }
export async function startAdminRuntime(options: AdminRuntimeOptions = {}) {
  const adminToken = requireAdminToken();
  const config = options.config ?? loadConfig(options.configDir);
  const port = options.port ?? Number(process.env.CV_ADMIN_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid admin port');
  // Loopback by default; containers set CV_ADMIN_HOST=0.0.0.0 so the HOST-side
  // 127.0.0.1 port publishing keeps the surface private.
  const host = process.env.CV_ADMIN_HOST || '127.0.0.1';
  const connection = new BetterSqlite3(path.join(config.dataDir, 'applications.db'), { readonly: true, fileMustExist: true, timeout: 1000 });
  let server: ReturnType<typeof createAdminServer> | undefined;
  const handlers = new Map<NodeJS.Signals, () => void>();
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    handlers.clear();
    try { await server?.close(); } finally { connection.close(); }
  })();
  try {
    server = createAdminServer(config, connection, { adminToken });
    await server.listen({ port, host });
    if (options.registerSignals !== false) for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = () => { void stop().catch(() => { process.exitCode = 1; }); };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    return { server, stop };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void startAdminRuntime().catch(() => { console.error('Private admin startup failed'); process.exitCode = 1; });
}
