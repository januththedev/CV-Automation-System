/**
 * SQLite (better-sqlite3, WAL) persistence for the CV automation appliance.
 *
 * - Migrations are inline and versioned (no .sql files to copy into dist).
 * - All access goes through prepared statements.
 * - recordInbound() performs the whole inbound receipt (dedupe, application
 *   resolution/creation, message, session, durable pending-work row) in a
 *   single IMMEDIATE transaction.
 *
 * Public API is documented in src/database/INTERFACE.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import {
  applicationRecordFromApplication,
  type Application,
  type ApplicationStatus,
  type CandidateRecord,
  type InboundMessage,
} from '../contracts.js';

type SqliteDatabase = BetterSqlite3.Database;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Application row as stored, including DB-owned subsystem fields. */
export interface DatabaseApplication extends Application {
  media_id: string | null;
  cv_filename: string | null;
  cv_mime_type: string | null;
  /** Raw AI extraction JSON (ExtractedCandidate), stored verbatim. */
  extraction_json: string | null;
  /** WhatsApp number of the session that opened this application. */
  session_id: string | null;
  /** Application id this record was conservatively marked duplicate of. */
  duplicate_of: string | null;
  /** Bumped on every durable change. */
  revision: number;
  /** Revision the worker last persisted as handled. */
  processed_revision: number;
}

export interface CreateApplicationInput {
  id?: string;
  whatsapp_jid: string;
  whatsapp_number: string;
  name?: string | null;
  nic?: string | null;
  address?: string | null;
  cv_phone_number?: string | null;
  profession?: string | null;
  status?: ApplicationStatus;
  review?: boolean;
  error?: string | null;
  onedrive_file_id?: string | null;
  onedrive_url?: string | null;
  cv_file_hash?: string | null;
  sheet_row_number?: number | null;
  cv_local_path?: string | null;
  confirmation_sent?: boolean;
  media_id?: string | null;
  cv_filename?: string | null;
  cv_mime_type?: string | null;
  extraction_json?: string | null;
  session_id?: string | null;
  duplicate_of?: string | null;
  revision?: number;
  processed_revision?: number;
  created_at?: string;
}

export type ApplicationPatch = Omit<
  Partial<CreateApplicationInput>,
  'id' | 'revision' | 'processed_revision' | 'whatsapp_jid' | 'whatsapp_number'
> & { processed_revision?: number };

export interface ApplicationListFilter {
  status?: ApplicationStatus | ApplicationStatus[];
  whatsapp_number?: string;
  review?: boolean;
  limit?: number;
  offset?: number;
}

export interface Session {
  /** E.164 WhatsApp number, e.g. 94771234567 — primary key. */
  whatsapp_number: string;
  /** Application currently open for this number. */
  application_id: string;
  /** ISO timestamp of the last inbound event seen for this session. */
  updated_at: string;
  /** Greeting/ack template already sent for the current session. */
  greeting_sent: boolean;
}

export interface StoredMessage extends InboundMessage {
  id: number;
  /** Application the message was filed under at receive time. */
  application_id: string;
}

export interface PendingWork {
  id: number;
  application_id: string;
  /** Originating message; dedupe key for queue publication. */
  wa_message_id: string;
  revision: number;
  created_at: string;
  dispatched_at: string | null;
}

export interface InboundResult {
  application: DatabaseApplication;
  duplicate: boolean;
  hasDocument: boolean;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

const NIC_RE = /^(?:\d{9}[VX]|\d{12})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Conservative NIC normalization: trim + uppercase + shape check. */
export function normalizeNic(nic: string | null | undefined): string | null {
  if (!nic) return null;
  const t = nic.trim().toUpperCase();
  return NIC_RE.test(t) ? t : null;
}

/** Conservative hash normalization: trim + lowercase + sha256 shape check. */
export function normalizeHash(hash: string | null | undefined): string | null {
  if (!hash) return null;
  const t = hash.trim().toLowerCase();
  return SHA256_RE.test(t) ? t : null;
}

/**
 * Accepts ISO-8601 strings (the canonical contract), epoch seconds (the
 * WhatsApp Cloud API wire format, ~1.7e9) and epoch milliseconds. Returns ms
 * since the Unix epoch, or null when the value cannot be interpreted.
 */
function parseWaTimestamp(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return normalizeEpoch(raw);
  const s = raw.trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    return normalizeEpoch(Number(s));
  }
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : d;
}

/**
 * Distinguish seconds from milliseconds conservatively: values below 1e11
 * cannot be milliseconds for any real current date, so treat them as seconds.
 * Sub-second precision is truncated to whole milliseconds.
 */
function normalizeEpoch(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e11 ? n * 1000 : n;
  return Math.trunc(ms);
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function clampLimit(limit: number | undefined, def: number, max: number): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit)) return def;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

// ---------------------------------------------------------------------------
// Migrations (inline — nothing to copy to dist)
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  up: (conn: SqliteDatabase) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (conn) => {
      conn.exec(`
        CREATE TABLE IF NOT EXISTS counters (
          key   TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS applications (
          id                 TEXT PRIMARY KEY,
          created_at         TEXT    NOT NULL,
          updated_at         TEXT    NOT NULL,
          whatsapp_jid       TEXT    NOT NULL,
          whatsapp_number    TEXT    NOT NULL,
          name               TEXT,
          nic                TEXT,
          address            TEXT,
          cv_phone_number    TEXT,
          profession         TEXT,
          status             TEXT    NOT NULL DEFAULT 'RECEIVED',
          review             INTEGER NOT NULL DEFAULT 0,
          error              TEXT,
          onedrive_file_id   TEXT,
          onedrive_url       TEXT,
          cv_file_hash       TEXT,
          sheet_row_number   INTEGER,
          cv_local_path      TEXT,
          confirmation_sent  INTEGER NOT NULL DEFAULT 0,
          media_id           TEXT,
          cv_filename        TEXT,
          cv_mime_type       TEXT,
          extraction_json    TEXT,
          session_id         TEXT,
          duplicate_of       TEXT REFERENCES applications(id),
          revision           INTEGER NOT NULL DEFAULT 1,
          processed_revision INTEGER NOT NULL DEFAULT 0,
          CHECK (typeof(revision) = 'integer' AND revision >= 1),
          CHECK (typeof(processed_revision) = 'integer' AND processed_revision >= 0 AND processed_revision <= revision)
        );

        CREATE INDEX IF NOT EXISTS idx_applications_whatsapp_number
          ON applications (whatsapp_number);
        CREATE INDEX IF NOT EXISTS idx_applications_nic
          ON applications (nic);
        CREATE INDEX IF NOT EXISTS idx_applications_cv_file_hash
          ON applications (cv_file_hash);
        CREATE INDEX IF NOT EXISTS idx_applications_status
          ON applications (status);
        CREATE INDEX IF NOT EXISTS idx_applications_session_id
          ON applications (session_id) WHERE session_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS sessions (
          whatsapp_number TEXT PRIMARY KEY,
          application_id  TEXT    NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
          updated_at      TEXT    NOT NULL,
          greeting_sent   INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_application
          ON sessions (application_id);

        CREATE TABLE IF NOT EXISTS messages (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          whatsapp_number TEXT    NOT NULL,
          from_jid        TEXT    NOT NULL,
          application_id  TEXT    NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
          wa_message_id   TEXT    NOT NULL UNIQUE,
          direction       TEXT    NOT NULL DEFAULT 'inbound',
          type            TEXT    NOT NULL,
          text            TEXT,
          media_id        TEXT,
          media_mime_type TEXT,
          media_filename  TEXT,
          at              TEXT    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_messages_application
          ON messages (application_id, at, id);
        CREATE INDEX IF NOT EXISTS idx_messages_number
          ON messages (whatsapp_number);

        CREATE TABLE IF NOT EXISTS extract_results (
          application_id TEXT PRIMARY KEY,
          json           TEXT NOT NULL,
          model          TEXT,
          created_at     TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pending_work (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          application_id TEXT    NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
          wa_message_id  TEXT    NOT NULL UNIQUE,
          revision       INTEGER NOT NULL,
          created_at     TEXT    NOT NULL,
          dispatched_at  TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_pending_work_undispatched
          ON pending_work (dispatched_at, id);
      `);
    },
  },
  {
    version: 2,
    up: (conn) => {
      conn.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
];

const KEY_SCHEMA_VERSION = 'schema_version';

/** Valid application statuses for runtime guards. */
const STATUS_SET: ReadonlySet<string> = new Set<string>([
  'RECEIVED', 'IDENTIFYING_CANDIDATE', 'WAITING_FOR_DETAILS', 'DOCUMENT_RECEIVED',
  'DOWNLOADING', 'AI_PROCESSING', 'VALIDATING', 'DUPLICATE_CHECK',
  'UPLOADING_TO_ONEDRIVE', 'CREATING_LINK', 'WRITING_TO_GOOGLE_SHEETS',
  'COMPLETED', 'NEEDS_REVIEW', 'RETRY_PENDING', 'FAILED',
]);

interface CountersRow {
  key: string;
  value: number;
}

interface AppRow {
  id: string;
  created_at: string;
  updated_at: string;
  whatsapp_jid: string;
  whatsapp_number: string;
  name: string | null;
  nic: string | null;
  address: string | null;
  cv_phone_number: string | null;
  profession: string | null;
  status: string;
  review: number;
  error: string | null;
  onedrive_file_id: string | null;
  onedrive_url: string | null;
  cv_file_hash: string | null;
  sheet_row_number: number | null;
  cv_local_path: string | null;
  confirmation_sent: number;
  media_id: string | null;
  cv_filename: string | null;
  cv_mime_type: string | null;
  extraction_json: string | null;
  session_id: string | null;
  duplicate_of: string | null;
  revision: number;
  processed_revision: number;
}

interface SessionRow {
  whatsapp_number: string;
  application_id: string;
  updated_at: string;
  greeting_sent: number;
}

interface MessageRow {
  id: number;
  whatsapp_number: string;
  application_id: string;
  wa_message_id: string;
  direction: string;
  from_jid: string;
  type: string;
  text: string | null;
  media_id: string | null;
  media_mime_type: string | null;
  media_filename: string | null;
  at: string;
}

interface WorkRow {
  id: number;
  application_id: string;
  wa_message_id: string;
  revision: number;
  created_at: string;
  dispatched_at: string | null;
}

function rowToApplication(r: AppRow): DatabaseApplication {
  return {
    id: r.id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    whatsapp_jid: r.whatsapp_jid,
    whatsapp_number: r.whatsapp_number,
    name: r.name,
    nic: r.nic,
    address: r.address,
    cv_phone_number: r.cv_phone_number,
    profession: r.profession,
    status: r.status as ApplicationStatus,
    review: r.review !== 0,
    error: r.error,
    onedrive_file_id: r.onedrive_file_id,
    onedrive_url: r.onedrive_url,
    cv_file_hash: r.cv_file_hash,
    sheet_row_number: r.sheet_row_number,
    cv_local_path: r.cv_local_path,
    confirmation_sent: r.confirmation_sent !== 0,
    media_id: r.media_id,
    cv_filename: r.cv_filename,
    cv_mime_type: r.cv_mime_type,
    extraction_json: r.extraction_json,
    session_id: r.session_id,
    duplicate_of: r.duplicate_of,
    revision: r.revision,
    processed_revision: r.processed_revision,
  };
}

function rowToSession(r: SessionRow): Session {
  return {
    whatsapp_number: r.whatsapp_number,
    application_id: r.application_id,
    updated_at: r.updated_at,
    greeting_sent: r.greeting_sent !== 0,
  };
}

function rowToMessage(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    application_id: r.application_id,
    wa_message_id: r.wa_message_id,
    from_jid: r.from_jid,
    from_number: r.whatsapp_number,
    timestamp: r.at,
    type: r.type as InboundMessage['type'],
    text: r.text,
    media_id: r.media_id,
    media_mime_type: r.media_mime_type,
    media_filename: r.media_filename,
  };
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let db: SqliteDatabase | null = null;
let dbPath: string | null = null;

/** Default DB location: SQLITE_PATH or DATA_DIR/applications.db (dev: ./data/cv-auto). */
function defaultDbPath(): string {
  if (process.env.SQLITE_PATH) return process.env.SQLITE_PATH;
  const dataDir = process.env.CV_DATA_DIR || process.env.DATA_DIR || './data/cv-auto';
  return path.join(dataDir, 'applications.db');
}

function migrate(conn: SqliteDatabase): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS counters (
      key   TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
  const row = conn
    .prepare('SELECT value FROM counters WHERE key = ?')
    .get(KEY_SCHEMA_VERSION) as CountersRow | undefined;
  const current = row ? row.value : 0;
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      m.up(conn);
      conn
        .prepare(
          'INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(KEY_SCHEMA_VERSION, m.version);
    }
  }
}

/**
 * Open (or return the already open) database connection. Enables WAL,
 * foreign keys and a busy timeout, then applies pending inline migrations.
 * Pass a different path only after closeDb().
 */
export function getDb(p?: string): SqliteDatabase {
  if (db && p === undefined) return db;
  const target = p === ':memory:' ? p : path.resolve(p ?? defaultDbPath());
  if (db) {
    if (dbPath !== target) {
      throw new Error(
        `Database already open at ${dbPath}. Call closeDb() before opening ${target}.`,
      );
    }
    return db;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const conn = new BetterSqlite3(target);
  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');

  const runMigrations = conn.transaction(() => migrate(conn));
  runMigrations.immediate();

  db = conn;
  dbPath = target;
  return db;
}

export function closeDb(): void {
  if (!db) return;
  const closing = db;
  db = null;
  dbPath = null;
  closing.close();
}

// ---------------------------------------------------------------------------
// Application ID counter
// ---------------------------------------------------------------------------

/**
 * Persisted appliance settings (schema version 2). The notification number is
 * stored here so every admin notice follows the number the operator chose at
 * setup, independent of container environment overrides.
 */
export const NOTIFICATION_NUMBER_KEY = 'notification_number';

export function setSetting(key: string, value: string): void {
  const conn = getDb();
  conn
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
  // Checkpoint immediately: strictly read-only readers (the private admin
  // runtime, notifications) cannot see uncheckpointed WAL frames while the
  // runtime connection keeps the database open.
  conn.pragma('wal_checkpoint(TRUNCATE)');
}

export function getSetting(key: string): string | null {
  const conn = getDb();
  const row = conn.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

/**
 * Read a setting through a strictly read-only connection that never creates
 * the database file or its schema. Returns null when the file is absent or
 * the table has not been migrated yet.
 */
export function readSetting(dbPath: string, key: string): string | null {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  try {
    const conn = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = conn.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row ? row.value : null;
    } catch {
      return null;
    } finally {
      conn.close();
    }
  } catch {
    return null;
  }
}

/** Stable application id: APP-YYYY-NNNNNN (six digits, transaction-safe). */
export function nextApplicationId(): string {
  const conn = getDb();
  const year = new Date().getUTCFullYear();
  const key = `app_id_${year}`;
  const txn = conn.transaction((): number => {
    const row = conn
      .prepare('SELECT value FROM counters WHERE key = ?')
      .get(key) as CountersRow | undefined;
    if (!row) {
      conn.prepare('INSERT INTO counters (key, value) VALUES (?, 1)').run(key);
      return 1;
    }
    conn
      .prepare('UPDATE counters SET value = value + 1 WHERE key = ?')
      .run(key);
    return row.value + 1;
  });
  const n = txn.immediate();
  return `APP-${year}-${String(n).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Application repo
// ---------------------------------------------------------------------------

const APP_COLUMNS = `
  id, created_at, updated_at, whatsapp_jid, whatsapp_number, name, nic,
  address, cv_phone_number, profession, status, review, error,
  onedrive_file_id, onedrive_url, cv_file_hash, sheet_row_number,
  cv_local_path, confirmation_sent, media_id, cv_filename, cv_mime_type,
  extraction_json, session_id, duplicate_of, revision, processed_revision
`;

/** Column list for read-only consumers that must not import the writer repo. */
export const APPLICATION_COLUMNS = APP_COLUMNS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRawAppRow(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === 'string' &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string' &&
    typeof value.whatsapp_jid === 'string' &&
    typeof value.whatsapp_number === 'string' &&
    typeof value.status === 'string' &&
    STATUS_SET.has(value.status) &&
    (value.review === 0 || value.review === 1) &&
    (value.confirmation_sent === 0 || value.confirmation_sent === 1) &&
    typeof value.revision === 'number' &&
    typeof value.processed_revision === 'number'
  );
}

/** Runtime guard for rows read through direct (non-repo) connections. */
export function isDatabaseApplication(value: unknown): boolean {
  return isRecord(value) && isRawAppRow(value);
}

/**
 * Validate and convert one raw row (numeric flags) into the canonical record;
 * returns null when the row shape is not an application.
 */
export function toDatabaseApplication(value: unknown): DatabaseApplication | null {
  if (!isRecord(value) || !isRawAppRow(value)) return null;
  return rowToApplication(value as unknown as AppRow);
}

const INSERT_APPLICATION_SQL = `
  INSERT INTO applications (
    id, created_at, updated_at, whatsapp_jid, whatsapp_number, name, nic,
    address, cv_phone_number, profession, status, review, error,
    onedrive_file_id, onedrive_url, cv_file_hash, sheet_row_number,
    cv_local_path, confirmation_sent, media_id, cv_filename, cv_mime_type,
    extraction_json, session_id, duplicate_of, revision, processed_revision
  ) VALUES (
    @id, @created_at, @updated_at, @whatsapp_jid, @whatsapp_number, @name, @nic,
    @address, @cv_phone_number, @profession, @status, @review, @error,
    @onedrive_file_id, @onedrive_url, @cv_file_hash, @sheet_row_number,
    @cv_local_path, @confirmation_sent, @media_id, @cv_filename, @cv_mime_type,
    @extraction_json, @session_id, @duplicate_of, @revision, @processed_revision
  )
`;

function emptyAppRow(id: string, whatsappJid: string, whatsappNumber: string, now: string): AppRow {
  return {
    id,
    created_at: now,
    updated_at: now,
    whatsapp_jid: whatsappJid,
    whatsapp_number: whatsappNumber,
    name: null,
    nic: null,
    address: null,
    cv_phone_number: null,
    profession: null,
    status: 'RECEIVED',
    review: 0,
    error: null,
    onedrive_file_id: null,
    onedrive_url: null,
    cv_file_hash: null,
    sheet_row_number: null,
    cv_local_path: null,
    confirmation_sent: 0,
    media_id: null,
    cv_filename: null,
    cv_mime_type: null,
    extraction_json: null,
    session_id: null,
    duplicate_of: null,
    revision: 1,
    processed_revision: 0,
  };
}

function getAppRow(conn: SqliteDatabase, id: string): AppRow | undefined {
  return conn
    .prepare(`SELECT ${APP_COLUMNS} FROM applications WHERE id = ?`)
    .get(id) as AppRow | undefined;
}

export function getApplicationById(id: string): DatabaseApplication | null {
  const row = getAppRow(getDb(), id);
  return row ? rowToApplication(row) : null;
}

export function createApplication(
  input: CreateApplicationInput,
): DatabaseApplication {
  const conn = getDb();
  if (!input.whatsapp_jid || !input.whatsapp_number) {
    throw new Error(
      'createApplication requires whatsapp_jid and whatsapp_number',
    );
  }
  const now = isoOf(Date.now());
  const row = emptyAppRow(
    input.id ?? nextApplicationId(),
    input.whatsapp_jid,
    input.whatsapp_number,
    input.created_at ?? now,
  );
  row.updated_at = now;
  row.name = input.name ?? null;
  row.nic = input.nic ?? null;
  row.address = input.address ?? null;
  row.cv_phone_number = input.cv_phone_number ?? null;
  row.profession = input.profession ?? null;
  row.status = input.status ?? 'RECEIVED';
  row.review = input.review ? 1 : 0;
  row.error = input.error ?? null;
  row.onedrive_file_id = input.onedrive_file_id ?? null;
  row.onedrive_url = input.onedrive_url ?? null;
  row.cv_file_hash = input.cv_file_hash ?? null;
  row.sheet_row_number = input.sheet_row_number ?? null;
  row.cv_local_path = input.cv_local_path ?? null;
  row.confirmation_sent = input.confirmation_sent ? 1 : 0;
  row.media_id = input.media_id ?? null;
  row.cv_filename = input.cv_filename ?? null;
  row.cv_mime_type = input.cv_mime_type ?? null;
  row.extraction_json = input.extraction_json ?? null;
  row.session_id = input.session_id ?? null;
  row.duplicate_of = input.duplicate_of ?? null;
  row.revision = input.revision ?? 1;
  row.processed_revision = Math.min(input.processed_revision ?? 0, row.revision);

  const info = conn.prepare(INSERT_APPLICATION_SQL).run(row);
  if (info.changes !== 1) throw new Error(`Failed to create application ${row.id}`);
  return rowToApplication(row);
}

// application_patch: only these fields (plus processed_revision) may change.
const PATCHABLE_FIELDS = [
  'name',
  'nic',
  'address',
  'cv_phone_number',
  'profession',
  'status',
  'review',
  'error',
  'onedrive_file_id',
  'onedrive_url',
  'cv_file_hash',
  'sheet_row_number',
  'cv_local_path',
  'confirmation_sent',
  'media_id',
  'cv_filename',
  'cv_mime_type',
  'extraction_json',
  'session_id',
  'duplicate_of',
  'processed_revision',
] as const;

const BOOLEAN_PATCH_FIELDS = new Set<string>(['review', 'confirmation_sent']);

/**
 * Update an application. When expectedRevision is provided the update only
 * applies if the stored revision still equals it (optimistic concurrency);
 * missing or stale applications return null. This call does not bump
 * revision itself — inbound receipt owns revision increments.
 */
export function updateApplication(
  id: string,
  patch: ApplicationPatch,
  expectedRevision?: number,
): DatabaseApplication | null {
  const conn = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const field of PATCHABLE_FIELDS) {
    if (!(field in patch)) continue;
    const raw = (patch as Record<string, unknown>)[field];
    if (raw === undefined) continue;
    if (field === 'processed_revision' && typeof raw !== 'number') continue;
    sets.push(`${field} = ?`);
    values.push(BOOLEAN_PATCH_FIELDS.has(field) ? (raw ? 1 : 0) : raw);
  }
  if (sets.length === 0 && expectedRevision === undefined) {
    return getApplicationById(id);
  }

  sets.push('updated_at = ?');
  values.push(isoOf(Date.now()), id);
  if (expectedRevision !== undefined) values.push(expectedRevision);

  const info = conn
    .prepare(
      `UPDATE applications SET ${sets.join(', ')} WHERE id = ?${
        expectedRevision !== undefined ? ' AND revision = ?' : ''
      }`,
    )
    .run(...values);
  if (info.changes === 0) return null; // missing or stale revision
  const row = getAppRow(conn, id);
  return row ? rowToApplication(row) : null;
}

export function listApplications(
  filter?: ApplicationListFilter,
): DatabaseApplication[] {
  const conn = getDb();
  const where: string[] = [];
  const values: unknown[] = [];

  if (filter?.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (statuses.length === 0) return [];
    if (statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      values.push(...statuses);
    }
  }
  if (filter?.whatsapp_number !== undefined) {
    where.push('whatsapp_number = ?');
    values.push(filter.whatsapp_number);
  }
  if (filter?.review !== undefined) {
    where.push('review = ?');
    values.push(filter.review ? 1 : 0);
  }

  const limit = clampLimit(filter?.limit, 100, 1000);
  const offset = Math.max(0, Math.trunc(filter?.offset ?? 0));
  const rows = conn
    .prepare(
      `SELECT ${APP_COLUMNS} FROM applications
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...values, limit, offset) as AppRow[];
  return rows.map(rowToApplication);
}

function latestApplicationByColumn(
  column: 'nic' | 'cv_file_hash' | 'whatsapp_number',
  value: string,
): DatabaseApplication | null {
  const row = getDb()
    .prepare(
      `SELECT ${APP_COLUMNS} FROM applications
       WHERE ${column} = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(value) as AppRow | undefined;
  return row ? rowToApplication(row) : null;
}

export function getApplicationByNic(nic: string): DatabaseApplication | null {
  return latestApplicationByColumn('nic', nic);
}

export function getApplicationByCvHash(hash: string): DatabaseApplication | null {
  return latestApplicationByColumn('cv_file_hash', normalizeHash(hash) ?? hash);
}

/**
 * Lookup by WhatsApp number. A matching number alone is NOT proof of identity
 * — callers must treat the result as a candidate, never auto-merge.
 */
export function getApplicationByWhatsAppNumber(
  number: string,
): DatabaseApplication | null {
  return latestApplicationByColumn('whatsapp_number', number);
}

export function toCandidateRecord(app: DatabaseApplication): ReturnType<
  typeof applicationRecordFromApplication
> {
  return applicationRecordFromApplication(app);
}

/**
 * Conservative duplicate check: matches ONLY on a valid normalized NIC or a
 * valid SHA-256 CV hash. Name/phone similarity never merges unrelated
 * persons. Returns the matched record for review; never mutates anything.
 */
export function findDuplicate(applicationId: string): DatabaseApplication | null {
  const conn = getDb();
  const self = getAppRow(conn, applicationId);
  if (!self) return null;

  const nic = normalizeNic(self.nic);
  if (nic) {
    const row = conn
      .prepare(
        `SELECT ${APP_COLUMNS} FROM applications
         WHERE id != ? AND TRIM(UPPER(nic)) = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(self.id, nic) as AppRow | undefined;
    if (row) return rowToApplication(row);
  }

  const hash = normalizeHash(self.cv_file_hash);
  if (hash) {
    const row = conn
      .prepare(
        `SELECT ${APP_COLUMNS} FROM applications
         WHERE id != ? AND LOWER(TRIM(cv_file_hash)) = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(self.id, hash) as AppRow | undefined;
    if (row) return rowToApplication(row);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Session repo
// ---------------------------------------------------------------------------

export function getSession(whatsappNumber: string): Session | null {
  const row = getDb()
    .prepare('SELECT * FROM sessions WHERE whatsapp_number = ?')
    .get(whatsappNumber) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

/** Explicit full-session write; for inbound handling prefer recordInbound. */
export function upsertSession(input: Session): Session {
  const conn = getDb();
  const app = getAppRow(conn, input.application_id);
  if (!app) {
    throw new Error(
      `Cannot attach session to missing application ${input.application_id}`,
    );
  }
  conn
    .prepare(
      `INSERT INTO sessions (whatsapp_number, application_id, updated_at, greeting_sent)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(whatsapp_number) DO UPDATE SET
         application_id = excluded.application_id,
         updated_at = excluded.updated_at,
         greeting_sent = excluded.greeting_sent`,
    )
    .run(
      input.whatsapp_number,
      input.application_id,
      input.updated_at,
      input.greeting_sent ? 1 : 0,
    );
  if (app.session_id !== input.whatsapp_number) {
    conn
      .prepare(
        'UPDATE applications SET session_id = ?, updated_at = ? WHERE id = ?',
      )
      .run(input.whatsapp_number, input.updated_at, input.application_id);
  }
  const out = getSession(input.whatsapp_number);
  if (!out) throw new Error('Session upsert failed');
  return out;
}

/**
 * Mark greeting sent, but only if the session still belongs to the given
 * application. Returns false when the session moved on (caller should not
 * send a stale greeting).
 */
export function markGreetingSent(
  whatsappNumber: string,
  applicationId: string,
): boolean {
  const info = getDb()
    .prepare(
      `UPDATE sessions SET greeting_sent = 1
       WHERE whatsapp_number = ? AND application_id = ? AND greeting_sent = 0`,
    )
    .run(whatsappNumber, applicationId);
  return info.changes === 1;
}

// ---------------------------------------------------------------------------
// Message repo
// ---------------------------------------------------------------------------

/**
 * Low-level insert of an inbound message. Returns false when the
 * wa_message_id already exists (webhook replay). Does not touch sessions,
 * applications or pending work — use recordInbound for that.
 */
export function saveMessage(applicationId: string, msg: InboundMessage): boolean {
  const conn = getDb();
  const app = getAppRow(conn, applicationId);
  if (!app) throw new Error(`Unknown application ${applicationId}`);
  const at = isoOf(parseWaTimestamp(msg.timestamp) ?? Date.now());
  const info = conn
    .prepare(
      `INSERT OR IGNORE INTO messages (
         whatsapp_number, application_id, wa_message_id, direction, type,
         text, media_id, media_mime_type, media_filename, at
       , from_jid) VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      app.whatsapp_number,
      applicationId,
      msg.wa_message_id,
      msg.type,
      msg.text ?? null,
      msg.media_id ?? null,
      msg.media_mime_type ?? null,
      msg.media_filename ?? null,
      at,
      msg.from_jid,
    );
  return info.changes === 1;
}

export function getMessageByWaId(waMessageId: string): StoredMessage | null {
  const row = getDb()
    .prepare('SELECT * FROM messages WHERE wa_message_id = ?')
    .get(waMessageId) as MessageRow | undefined;
  return row ? rowToMessage(row) : null;
}

function messagesForApplication(
  conn: SqliteDatabase,
  applicationId: string,
): StoredMessage[] {
  const rows = conn
    .prepare('SELECT * FROM messages WHERE application_id = ? ORDER BY at, id')
    .all(applicationId) as MessageRow[];
  return rows.map(rowToMessage);
}

export function listApplicationMessages(applicationId: string): StoredMessage[] {
  return messagesForApplication(getDb(), applicationId);
}

/** Messages filed under the application the number's CURRENT session points at. */
export function listSessionMessages(whatsappNumber: string): StoredMessage[] {
  const conn = getDb();
  const session = getSession(whatsappNumber);
  if (!session) return [];
  return messagesForApplication(conn, session.application_id);
}

// ---------------------------------------------------------------------------
// Pending work (durable outbox for webhook -> queue recovery)
// ---------------------------------------------------------------------------

export function listPendingWork(limit?: number): PendingWork[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM pending_work
       WHERE dispatched_at IS NULL
       ORDER BY id
       LIMIT ?`,
    )
    .all(clampLimit(limit, 100, 1000)) as WorkRow[];
  return rows.map((r) => ({ ...r }));
}

export function getPendingWorkByMessageId(waMessageId: string): PendingWork | null {
  const row = getDb()
    .prepare(
      'SELECT * FROM pending_work WHERE wa_message_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(waMessageId) as WorkRow | undefined;
  return row ? { ...row } : null;
}

/**
 * Unhandled document revisions and candidate messages recoverable after Redis loss.
 * The ID cursor remains valid when earlier rows cease to qualify during processing.
 */
export function listRecoveryApplications(limit?: number, afterId = ''): DatabaseApplication[] {
  const rows = getDb()
    .prepare(
      `SELECT ${APP_COLUMNS} FROM applications
       WHERE id > ? AND ((
         (media_id IS NOT NULL OR cv_local_path IS NOT NULL)
           AND revision > processed_revision
       ) OR (
         status = 'WAITING_FOR_DETAILS'
       ) OR (
         status = 'COMPLETED' AND confirmation_sent = 0
       ) OR (
         status = 'RECEIVED' AND media_id IS NULL AND cv_local_path IS NULL
           AND revision > processed_revision
           AND EXISTS (SELECT 1 FROM sessions s
             WHERE s.whatsapp_number = applications.whatsapp_number
               AND s.application_id = applications.id AND s.greeting_sent = 0)
       ))
       ORDER BY id
       LIMIT ?`,
    )
    .all(afterId, clampLimit(limit, 100, 1000)) as AppRow[];
  return rows.map(rowToApplication);
}

/**
 * Acknowledge durable work ONLY after it was durably published to the queue.
 * Returns true for the first acknowledgement, false if already dispatched.
 */
export function markWorkDispatched(id: number): boolean {
  const info = getDb()
    .prepare(
      'UPDATE pending_work SET dispatched_at = ? WHERE id = ? AND dispatched_at IS NULL',
    )
    .run(isoOf(Date.now()), id);
  return info.changes === 1;
}

// ---------------------------------------------------------------------------
// Atomic inbound receipt
// ---------------------------------------------------------------------------

function isDocumentMessage(msg: InboundMessage): boolean {
  return msg.type === 'document' || (msg.type === 'image' && !!msg.media_id);
}

/**
 * Atomically handle one inbound message:
 *  - dedupe by wa_message_id BEFORE any session/application edit (webhook
 *    replays return the ORIGINAL application and change nothing),
 *  - resolve or create the session's application (timeout-aware),
 *  - store the message, upsert the session, bump revision,
 *  - record one durable pending_work row for queue recovery.
 *
 * Runs in a single IMMEDIATE transaction, so concurrent webhook deliveries
 * serialize safely. For deduplicated queue publication use an idempotent job
 * id such as `inbound-${work.id}` and acknowledge with markWorkDispatched()
 * only after durable enqueue.
 */
export function recordInbound(
  msg: InboundMessage,
  timeoutMinutes: number,
): InboundResult {
  const conn = getDb();
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 0) throw new Error('Invalid session timeout');
  if (!msg.wa_message_id || !msg.from_number || !msg.from_jid) throw new Error('Missing inbound metadata');
  const timeoutMs = timeoutMinutes * 60_000;
  const receiptMs = Date.now();
  const parsed = parseWaTimestamp(msg.timestamp);
  const eventMs = parsed !== null && parsed <= receiptMs ? parsed : receiptMs;
  const eventAt = isoOf(eventMs);
  const receiptAt = isoOf(receiptMs);
  const fromJid = msg.from_jid || `${msg.from_number}@s.whatsapp.net`;
  const isDoc = msg.type === 'document' || (msg.type === 'image' && !!msg.media_id);

  const txn = conn.transaction((): InboundResult => {
    // 1) Dedupe BEFORE any session/application edit.
    const existing = conn
      .prepare('SELECT * FROM messages WHERE wa_message_id = ?')
      .get(msg.wa_message_id) as MessageRow | undefined;
    if (existing) {
      const app = getAppRow(conn, existing.application_id);
      if (!app) {
        throw new Error(
          `Message ${msg.wa_message_id} references missing application ${existing.application_id}`,
        );
      }
      return {
        application: rowToApplication(app),
        duplicate: true,
        hasDocument: !!(app.media_id || app.cv_local_path),
      };
    }

    // 2) Resolve the open session, if any, and check its timeout window.
    const sessionRow = conn
      .prepare('SELECT * FROM sessions WHERE whatsapp_number = ?')
      .get(msg.from_number) as SessionRow | undefined;

    let sessionAppId: string | null = sessionRow ? sessionRow.application_id : null;
    if (sessionRow && sessionAppId) {
      const sessionApp = getAppRow(conn, sessionAppId);
      const lastMs = parseWaTimestamp(sessionRow.updated_at) ?? 0;
      // Use event time rather than receipt time so delayed webhook batches
      // remain grouped. A backdated message cannot force a new session.
      const referenceMs = eventMs;
      if (!sessionApp || referenceMs - lastMs > timeoutMs) {
        sessionAppId = null;
      }
    }

    // 3) Create or reuse the application.
    let before: DatabaseApplication;
    let created = false;
    if (sessionRow && sessionAppId) {
      const current = getAppRow(conn, sessionAppId);
      if (!current) {
        throw new Error(`Session points at missing application ${sessionAppId}`);
      }
      before = rowToApplication(current);
    } else {
      before = rowToApplication(
        (() => {
          const id = nextApplicationId();
          const row = emptyAppRow(id, fromJid, msg.from_number, receiptAt);
          row.session_id = msg.from_number;
          if (isDoc) {
            row.status = 'DOCUMENT_RECEIVED';
            row.media_id = msg.media_id ?? null;
            row.cv_filename = msg.media_filename ?? null;
            row.cv_mime_type = msg.media_mime_type ?? null;
          }
          conn.prepare(INSERT_APPLICATION_SQL).run(row);
          return getAppRow(conn, id)!;
        })(),
      );
      created = true;
    }

    // 4) Apply this message to the application (documents replace, text merges).
    let app = before;
    if (!created) {
      app = { ...before, revision: before.revision + 1 };
    }
    if (isDoc && msg.media_id) {
      app = {
        ...app,
        status: 'DOCUMENT_RECEIVED',
        confirmation_sent: false,
        media_id: msg.media_id,
        cv_filename: msg.media_filename ?? app.cv_filename,
        cv_mime_type: msg.media_mime_type ?? app.cv_mime_type,
        cv_local_path: null,
        cv_file_hash: null,
        onedrive_file_id: null,
        onedrive_url: null,
        extraction_json: null,
        duplicate_of: null,
        updated_at: eventAt,
      };
    } else {
      app = { ...app, updated_at: eventAt };
    }

    if (!created) {
      conn
        .prepare(
          `UPDATE applications SET
             status = ?, media_id = ?, cv_filename = ?, cv_mime_type = ?,
             cv_local_path = ?, cv_file_hash = ?, onedrive_file_id = ?,
             onedrive_url = ?, extraction_json = ?, duplicate_of = ?,
             revision = ?, updated_at = ?, confirmation_sent = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          app.status,
          app.media_id,
          app.cv_filename,
          app.cv_mime_type,
          app.cv_local_path,
          app.cv_file_hash,
          app.onedrive_file_id,
          app.onedrive_url,
          app.extraction_json,
          app.duplicate_of,
          app.revision,
          receiptAt,
          app.confirmation_sent ? 1 : 0,
          app.id,
          before.revision,
        );
    }

    // 5) File the message under the application.
    conn
      .prepare(
        `INSERT INTO messages (
           whatsapp_number, application_id, wa_message_id, direction, type,
           text, media_id, media_mime_type, media_filename, at
         , from_jid) VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        app.whatsapp_number,
        app.id,
        msg.wa_message_id,
        msg.type,
        msg.text ?? null,
        msg.media_id ?? null,
        msg.media_mime_type ?? null,
        msg.media_filename ?? null,
        eventAt,
        msg.from_jid,
      );

    // 6) Upsert the session for this number.
    conn
      .prepare(
        `INSERT INTO sessions (whatsapp_number, application_id, updated_at, greeting_sent)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(whatsapp_number) DO UPDATE SET
           application_id = excluded.application_id,
           updated_at = CASE WHEN sessions.application_id = excluded.application_id
             THEN MAX(sessions.updated_at, excluded.updated_at) ELSE excluded.updated_at END,
           greeting_sent = CASE WHEN sessions.application_id = excluded.application_id
             THEN sessions.greeting_sent ELSE 0 END`,
      )
      .run(msg.from_number, app.id, eventAt);

    // 7) Durable pending work for queue publication/recovery.
    conn
      .prepare(
        `INSERT INTO pending_work (application_id, wa_message_id, revision, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(app.id, msg.wa_message_id, app.revision, receiptAt);

    const finalRow = getAppRow(conn, app.id);
    if (!finalRow) throw new Error(`Application ${app.id} vanished`);
    return {
      application: rowToApplication(finalRow),
      duplicate: false,
      hasDocument: !!(finalRow.media_id || finalRow.cv_local_path),
    };
  });

  return txn.immediate();
}
