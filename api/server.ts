/** Import-safe webhook boundary; the runtime owns SQLite and listener lifecycle. */

import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { default as Fastify } from 'fastify';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../src/contracts.js';
import { loadConfig } from '../src/config.js';
import { parseWebhookPayload } from '../src/integrations/whatsapp/client.js';
import * as db from '../src/database/db.js';

/** Hard cap on the raw webhook body (original bytes) before any parsing. */
const MAX_BODY_BYTES = 1024 * 1024;

const GENERIC = {
  badRequest: { error: 'Bad Request' },
  payloadTooLarge: { error: 'Payload Too Large' },
  forbidden: { error: 'Forbidden' },
  unavailable: { error: 'Service Unavailable' },
  internal: { error: 'Internal Server Error' },
  notFound: { error: 'Not Found' },
} as const;

export interface ApiServerOptions {
  /** Maximum accepted raw body size in bytes. Defaults to 1 MiB. */
  maxBodyBytes?: number;
}

function statusReply(
  reply: FastifyReply,
  code: number,
  body: (typeof GENERIC)[keyof typeof GENERIC],
): FastifyReply {
  return reply.code(code).send(body);
}

/** sha256=<hex>, constant-time comparison against the exact original bytes. */
function signatureValid(raw: Buffer, header: unknown, appSecret: string): boolean {
  if (typeof header !== 'string') return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1].toLowerCase(), 'hex');
  const expected = createHmac('sha256', appSecret).update(raw).digest();
  return timingSafeEqual(provided, expected);
}

/** GET handshake only; constant-time token comparison. */
function verifyWebhookToken(mode: unknown, token: unknown, expected: string): boolean {
  if (mode !== 'subscribe' || typeof token !== 'string') return false;
  const actual = Buffer.from(token);
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function logFailure(operation: string): void {
  // Fixed strings only: never the request URL, body, tokens or raw errors.
  import('../src/logger.js')
    .then(({ logger }) => logger.error({ operation }, 'Webhook API request failed'))
    .catch(() => {});
}

/**
 * Import-safe Fastify factory. `connection` is caller-owned: used, never
 * closed. No ingestion happens anywhere except after a valid signature.
 */
export function createApiServer(
  config: AppConfig,
  connection: SqliteDatabase,
  options: ApiServerOptions = {},
): FastifyInstance {
  const maxBodyBytes = Math.max(1, Math.trunc(options.maxBodyBytes ?? MAX_BODY_BYTES));

  const app = Fastify({
    logger: false, // No default request logs; the shared logger gets fixed strings only.
    bodyLimit: maxBodyBytes,
  });

  // Disable Fastify's JSON parser: every body arrives as the untouched
  // original bytes so the HMAC covers exactly what the sender transmitted.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      (request as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      done(null, body as Buffer);
    },
  );

  app.setErrorHandler((error, request, reply) => {
    // body-limit violations keep their 413; every other parse/transport error
    // below 500 degrades to a generic 400. Never echo request details.
    if (error.statusCode === 413) {
      return statusReply(reply, 413, GENERIC.payloadTooLarge);
    }
    if (
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return statusReply(reply, 400, GENERIC.badRequest);
    }
    logFailure('request');
    return statusReply(reply, 500, GENERIC.internal);
  });
  app.setNotFoundHandler((_request, reply) => {
    return statusReply(reply, 404, GENERIC.notFound);
  });

  app.get('/health', (_request, reply) => {
    try {
      connection.prepare('SELECT 1').get();
      return reply.code(200).send({ sqlite: 'ok' });
    } catch {
      // SQLite only — explicitly NOT Redis, provider or worker readiness.
      return statusReply(reply, 503, GENERIC.unavailable);
    }
  });

  app.get('/webhook', (request, reply) => {
    const whatsapp = config.whatsapp;
    if (!whatsapp?.verifyToken) {
      return statusReply(reply, 503, GENERIC.unavailable);
    }
    const query = request.query as Record<string, unknown>;
    if (
      query['hub.mode'] === 'subscribe' &&
      typeof query['hub.verify_token'] === 'string' &&
      query['hub.verify_token'].length > 0 &&
      typeof query['hub.challenge'] === 'string' &&
      query['hub.challenge'].length > 0 &&
      verifyWebhookToken(query['hub.mode'], query['hub.verify_token'], whatsapp.verifyToken)
    ) {
      // Echo the challenge verbatim; never log it alongside the token.
      return reply
        .code(200)
        .header('content-type', 'text/plain; charset=utf-8')
        .send(query['hub.challenge']);
    }
    return statusReply(reply, 403, GENERIC.forbidden);
  });

  app.post('/webhook', (request, reply) => {
    const whatsapp = config.whatsapp;
    // Fail closed: no secret means no ingestion and no acknowledgement.
    if (!whatsapp?.appSecret) {
      return statusReply(reply, 503, GENERIC.unavailable);
    }
    const raw = (request as unknown as { rawBody?: Buffer }).rawBody;
    if (!Buffer.isBuffer(raw)) {
      return statusReply(reply, 400, GENERIC.badRequest);
    }
    if (raw.length > maxBodyBytes) {
      return statusReply(reply, 413, GENERIC.payloadTooLarge);
    }
    const signature = request.headers['x-hub-signature-256'];
    if (!signatureValid(raw, signature, whatsapp.appSecret)) {
      return statusReply(reply, 403, GENERIC.forbidden);
    }

    // Signature verified against the original bytes; only now parse JSON.
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return statusReply(reply, 400, GENERIC.badRequest);
    }

    try {
      const messages = parseWebhookPayload(payload);
      if (messages.length > 0) {
        // One transaction around the whole batch: no partial acknowledgement.
        connection
          .transaction(() => {
            for (const message of messages) {
              db.recordInbound(message, config.sessionTimeoutMinutes);
            }
          })
          .immediate();
      }
      // ACK only after the SQLite commit; the worker dispatcher publishes.
      return reply.code(200).send({ received: true });
    } catch {
      logFailure('ingest');
      return statusReply(reply, 500, GENERIC.internal);
    }
  });

  return app;
}

export interface ApiRuntimeOptions {
  config?: AppConfig;
  configDir?: string;
  registerSignals?: boolean;
}

export interface ApiRuntime {
  server: FastifyInstance;
  stop(): Promise<void>;
}

export async function startApiRuntime(options: ApiRuntimeOptions = {}): Promise<ApiRuntime> {
  const config = options.config ?? loadConfig(options.configDir);
  const connection = db.getDb(path.join(config.dataDir, 'applications.db'));
  let server: FastifyInstance | undefined;
  let stopping: Promise<void> | undefined;
  const handlers = new Map<NodeJS.Signals, () => void>();
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();
      try { await server?.close(); }
      finally { db.closeDb(); }
    })();
    return stopping;
  };
  try {
    server = createApiServer(config, connection);
    await server.listen({ port: config.apiPort, host: process.env.CV_API_HOST || '127.0.0.1' });
    if (options.registerSignals !== false) {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        const handler = () => { void stop().catch(() => { process.exitCode = 1; }); };
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
    }
    return { server, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
