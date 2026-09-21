import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InboundMessage } from '../../contracts.js';
import * as db from '../db.js';

let dir: string;
let file: string;
const number = '+94771234567';
function msg(id: string, minutes = 0, patch: Partial<InboundMessage> = {}): InboundMessage {
  return { wa_message_id: id, from_number: number, from_jid: '94771234567@s.whatsapp.net',
    timestamp: new Date(Date.parse('2026-09-17T10:00:00Z') + minutes * 60000).toISOString(),
    type: 'text', text: 'Hello', media_id: null, media_mime_type: null, media_filename: null, ...patch };
}
const document = { type: 'document' as const, media_id: 'media-1', media_filename: 'CV.pdf', media_mime_type: 'application/pdf' };
beforeEach(() => {
  dir = mkdtempSync(path.resolve('src/database/__tests__/tmp-'));
  file = path.join(dir, 'test.db');
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-17T12:00:00Z'));
  db.getDb(file);
});
afterEach(() => { db.closeDb(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe('database', () => {
  it('opens WAL with foreign keys, persists and reopens migrations', () => {
    expect(db.getDb().pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.getDb().pragma('foreign_keys', { simple: true })).toBe(1);
    const app = db.createApplication({ whatsapp_jid: 'jid', whatsapp_number: number });
    db.closeDb(); db.getDb(file);
    expect(db.getApplicationById(app.id)).toEqual(app);
    expect(() => db.getDb(path.join(dir, 'other.db'))).toThrow();
  });
  it('persists settings and reads them back through a non-creating readonly connection', () => {
    expect(db.getSetting(db.NOTIFICATION_NUMBER_KEY)).toBeNull();
    db.setSetting(db.NOTIFICATION_NUMBER_KEY, '+94771234567');
    expect(db.getSetting(db.NOTIFICATION_NUMBER_KEY)).toBe('+94771234567');
    db.setSetting(db.NOTIFICATION_NUMBER_KEY, '947700000001');
    expect(db.getSetting(db.NOTIFICATION_NUMBER_KEY)).toBe('947700000001');
    // readSetting survives a reopen and never creates files or schema.
    db.closeDb();
    expect(db.readSetting(file, db.NOTIFICATION_NUMBER_KEY)).toBe('947700000001');
    const missing = path.join(dir, 'absent.db');
    expect(db.readSetting(missing, db.NOTIFICATION_NUMBER_KEY)).toBeNull();
    expect(existsSync(missing)).toBe(false);
    db.getDb(file);
  });
  it('checkpoints settings so strictly read-only readers see them while the runtime holds the DB open', () => {
    const second = new BetterSqlite3(file);
    try {
      db.setSetting(db.NOTIFICATION_NUMBER_KEY, '947711223344');
      expect(db.readSetting(file, db.NOTIFICATION_NUMBER_KEY)).toBe('947711223344');
    } finally {
      second.close();
    }
  });
  it('reserves monotonic six-digit IDs and supports supplied reserved IDs', () => {
    const ids = Array.from({ length: 50 }, () => db.nextApplicationId());
    expect(new Set(ids).size).toBe(50);
    expect(ids[0]).toMatch(/^APP-\d{4}-000001$/);
    expect(ids[49]).toMatch(/000050$/);
    expect(db.createApplication({ id: ids[0], whatsapp_jid: 'jid', whatsapp_number: number }).id).toBe(ids[0]);
  });
  it('CRUD preserves nulls, booleans and guarded revision completion', () => {
    const app = db.createApplication({ whatsapp_jid: 'jid', whatsapp_number: number, nic: '123456789V', cv_file_hash: 'a'.repeat(64) });
    expect(db.updateApplication(app.id, { review: true, name: 'Candidate', processed_revision: 1 }, 1)?.review).toBe(true);
    expect(db.updateApplication(app.id, { name: 'stale' }, 0)).toBeNull();
    expect(db.getApplicationByNic('123456789V')?.id).toBe(app.id);
    expect(db.getApplicationByCvHash('a'.repeat(64))?.id).toBe(app.id);
    expect(db.getApplicationByWhatsAppNumber(number)?.id).toBe(app.id);
    expect(db.listApplications({ review: true, status: ['RECEIVED'] })).toHaveLength(1);
    expect(db.listApplications({ status: [] })).toEqual([]);
    expect(db.updateApplication(app.id, { name: null })?.name).toBeNull();
    expect(() => db.updateApplication(app.id, { processed_revision: 100 })).toThrow();
  });
  it('groups text and documents, preserving greeting and all message metadata', () => {
    const first = db.recordInbound(msg('1'), 30);
    expect(first.hasDocument).toBe(false);
    db.markGreetingSent(number, first.application.id);
    for (let i = 2; i <= 3; i++) expect(db.recordInbound(msg(String(i), i), 30).application.id).toBe(first.application.id);
    const last = db.recordInbound(msg('4', 4, document), 30);
    expect(last.application).toMatchObject({ id: first.application.id, revision: 4, status: 'DOCUMENT_RECEIVED', media_id: 'media-1' });
    expect(last.hasDocument).toBe(true);
    expect(db.getSession(number)?.greeting_sent).toBe(true);
    expect(db.listApplicationMessages(first.application.id)).toHaveLength(4);
    expect(db.getMessageByWaId('4')).toMatchObject(msg('4', 4, document));
    expect(db.listPendingWork()).toHaveLength(4);
  });
  it('dedupes before edits even after the sender moves to a new session', () => {
    const first = db.recordInbound(msg('1'), 30);
    const second = db.recordInbound(msg('2', 31), 30);
    expect(first.application.id).not.toBe(second.application.id);
    const session = db.getSession(number);
    expect(db.recordInbound(msg('1', 100, document), 30)).toMatchObject({ duplicate: true, application: { id: first.application.id } });
    expect(db.getSession(number)).toEqual(session);
    expect(db.listSessionMessages(number).map(m => m.wa_message_id)).toEqual(['2']);
    expect(db.listPendingWork()).toHaveLength(2);
    expect(db.markGreetingSent(number, first.application.id)).toBe(false);
  });
  it('uses event gaps conservatively; equality, backdated, future and invalid timestamps', () => {
    const a = db.recordInbound(msg('1'), 30).application;
    expect(db.recordInbound(msg('2', 30), 30).application.id).toBe(a.id);
    db.recordInbound(msg('3', 1), 30);
    expect(db.getSession(number)?.updated_at).toBe(msg('2', 30).timestamp);
    const future = db.recordInbound(msg('4', 0, { timestamp: '2099-01-01T00:00:00Z' }), 30);
    expect(db.getSession(number)?.updated_at).toBe(new Date(Date.now()).toISOString());
    expect(db.recordInbound(msg('5', 0, { timestamp: 'invalid' }), 30).application.id).toBe(future.application.id);
  });
  it('rolls back application, session, message and counter when outbox insertion fails', () => {
    db.getDb().exec("CREATE TRIGGER reject_work BEFORE INSERT ON pending_work BEGIN SELECT RAISE(ABORT, 'fail'); END;");
    expect(() => db.recordInbound(msg('1'), 30)).toThrow('fail');
    expect(db.listApplications()).toEqual([]);
    expect(db.getSession(number)).toBeNull();
    expect(db.getMessageByWaId('1')).toBeNull();
    expect(db.nextApplicationId()).toMatch(/000001$/);
  });
  it('keeps outbox after reopen and tracks unprocessed revisions despite completed status', () => {
    const result = db.recordInbound(msg('1', 0, document), 30);
    db.closeDb(); db.getDb(file);
    const [work] = db.listPendingWork();
    expect(db.markWorkDispatched(work.id)).toBe(true);
    expect(db.markWorkDispatched(work.id)).toBe(false);
    expect(db.getPendingWorkByMessageId('1')?.dispatched_at).not.toBeNull();
    db.updateApplication(result.application.id, { status: 'COMPLETED' });
    expect(db.listRecoveryApplications()).toHaveLength(1);
    db.updateApplication(result.application.id, { processed_revision: 1 });
    expect(db.listRecoveryApplications()).toHaveLength(1);
    db.updateApplication(result.application.id, { confirmation_sent: true });
    expect(db.listRecoveryApplications()).toEqual([]);
    db.recordInbound(msg('2', 1), 30);
    expect(db.listRecoveryApplications()).toHaveLength(1);
  });
  it('selects waiting details without documents and pages by id without starvation', () => {
    const base = { whatsapp_jid: 'jid', whatsapp_number: number };
    const waiting = db.createApplication({ ...base, status: 'WAITING_FOR_DETAILS', processed_revision: 1, revision: 2 });
    const drained = db.createApplication({ ...base, status: 'COMPLETED', processed_revision: 3, revision: 3, confirmation_sent: true });
    const waitingBare = db.createApplication({ ...base, status: 'WAITING_FOR_DETAILS' });
    // A live RECEIVED session qualifies only with an unsent greeting (session row exists).
    const reception = db.recordInbound({ ...msg('greet'), from_number: '+94770000001', from_jid: '94770000001@s.whatsapp.net' }, 30).application;
    const listed = db.listRecoveryApplications(3);
    expect(listed.map(r => r.id)).toEqual([waiting.id, waitingBare.id, reception.id]);
    expect(db.listRecoveryApplications(2).map(r => r.id)).toEqual([waiting.id, waitingBare.id]);
    expect(db.listRecoveryApplications(3, waitingBare.id).map(r => r.id)).toEqual([reception.id]);
    expect(db.listRecoveryApplications(3, reception.id)).toEqual([]);
    expect(drained.status).toBe('COMPLETED');
  });
  it('resets document checkpoints but retains sheet row for replacement CV', () => {
    const a = db.recordInbound(msg('1', 0, document), 30).application;
    db.updateApplication(a.id, { cv_local_path: '/old', cv_file_hash: 'a'.repeat(64), onedrive_file_id: 'old', onedrive_url: 'url', sheet_row_number: 2, extraction_json: '{}', confirmation_sent: true, status: 'COMPLETED', processed_revision: 1 });
    const b = db.recordInbound(msg('2', 1, { ...document, media_id: 'new' }), 30).application;
    expect(b).toMatchObject({ media_id: 'new', cv_local_path: null, cv_file_hash: null, onedrive_file_id: null, onedrive_url: null, sheet_row_number: 2, extraction_json: null, confirmation_sent: false, status: 'DOCUMENT_RECEIVED', revision: 2, processed_revision: 1 });
  });
  it('duplicates use valid NIC/hash only; never merge or match name/phone alone', () => {
    const common = { whatsapp_jid: 'jid', whatsapp_number: number, name: 'Same Name', cv_phone_number: '0771234567' };
    const a = db.createApplication(common);
    const b = db.createApplication(common);
    expect(db.findDuplicate(b.id)).toBeNull();
    db.updateApplication(a.id, { nic: ' 123456789v ' });
    db.updateApplication(b.id, { nic: '123456789V' });
    expect(db.findDuplicate(b.id)?.id).toBe(a.id);
    expect(db.getApplicationById(b.id)?.duplicate_of).toBeNull();
    db.updateApplication(b.id, { nic: null, cv_file_hash: 'A'.repeat(64) });
    db.updateApplication(a.id, { cv_file_hash: 'a'.repeat(64) });
    expect(db.findDuplicate(b.id)?.id).toBe(a.id);
  });
  it('low-level message and session helpers preserve their limited responsibilities', () => {
    const a = db.createApplication({ whatsapp_jid: 'jid', whatsapp_number: number });
    db.upsertSession({ whatsapp_number: number, application_id: a.id, updated_at: msg('x').timestamp, greeting_sent: false });
    expect(db.saveMessage(a.id, msg('x'))).toBe(true);
    expect(db.saveMessage(a.id, msg('x'))).toBe(false);
    expect(db.listPendingWork()).toEqual([]);
    expect(db.listSessionMessages(number)).toHaveLength(1);
  });
  it('serializes concurrent process IDs and repeated inbound receipts', async () => {
    const fixture = path.resolve('src/database/__tests__/fixtures/contention-child.cjs');
    const run = promisify(execFile);
    const results = await Promise.all(Array.from({ length: 3 }, () => run(process.execPath, ['--import', 'tsx', fixture], { cwd: dir, timeout: 25000 })));
    const data = results.map(r => JSON.parse(r.stdout) as { ids: string[]; duplicate: boolean });
    expect(new Set(data.flatMap(r => r.ids)).size).toBe(45);
    expect(data.filter(r => !r.duplicate)).toHaveLength(1);
    expect(db.listApplications()).toHaveLength(1);
    expect(db.listPendingWork()).toHaveLength(1);
  });
  it('keeps IDs monotonic when another connection mutates the counter', () => {
    expect(db.nextApplicationId()).toMatch(/000001$/);
    const second = new BetterSqlite3(file);
    second.prepare("UPDATE counters SET value = value + 5 WHERE key = 'app_id_2026'").run();
    second.close();
    expect(db.nextApplicationId()).toMatch(/000007$/);
  });
});
