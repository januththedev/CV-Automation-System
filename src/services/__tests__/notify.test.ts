import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { WhatsAppConfig } from '../../contracts.js';
import { formatAdminMessage, sendAdmin } from '../notify.js';

vi.mock('../../config.js', () => ({ loadConfig: vi.fn(() => ({ whatsapp: null, adminWhatsappNumber: null })) }));
import { loadConfig } from '../../config.js';
const cfg: WhatsAppConfig = { accessToken: ['not', 'a', 'token'].join('-'), phoneNumberId: '123', wabaId: '456', verifyToken: ['not', 'a', 'verify'].join('-') };
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(fileURLToPath(new URL('.', import.meta.url)), 'tmp-notify-')); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe('admin notifications', () => {
  it('formats online, offline, failure, review and model events', () => {
    const message = formatAdminMessage({ type: 'online', deviceName: 'CV-AUTO-01', ip: '192.168.1.25', sshHint: 'ssh admin@192.168.1.25', dashboardUrl: 'http://192.168.1.25:3000', fingerprint: 'SHA256:abc' });
    for (const value of ['CV-AUTO-01', '192.168.1.25', 'ssh admin@192.168.1.25', 'http://192.168.1.25:3000', 'SHA256:abc', 'ONLINE']) expect(message).toContain(value);
    expect(formatAdminMessage({ type: 'offline', deviceName: 'device' })).toContain('OFFLINE');
    expect(formatAdminMessage({ type: 'failed', appId: 'APP-1', error: new Error('Bearer private') })).not.toContain('private');
    expect(formatAdminMessage({ type: 'review', appId: 'APP-1', missing: ['nic'] })).toContain('NIC');
    expect(formatAdminMessage({ type: 'model_changed', oldModel: 'a', newModel: 'b' })).toContain('b');
  });
  it('sends to the explicit admin using WhatsAppConfig', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}')); vi.stubGlobal('fetch', fetch);
    await sendAdmin({ type: 'offline', deviceName: 'device' }, cfg, '+94771234567');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ to: '94771234567', text: { body: expect.stringContaining('OFFLINE') } });
    expect(loadConfig).not.toHaveBeenCalled();
  });
  it('resolves omitted config and recipient from application config', async () => {
    vi.mocked(loadConfig).mockReturnValueOnce({ whatsapp: cfg, adminWhatsappNumber: '94771234567' } as ReturnType<typeof loadConfig>);
    const fetch = vi.fn().mockResolvedValue(new Response('{}')); vi.stubGlobal('fetch', fetch);
    await sendAdmin({ type: 'offline' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('prefers the notification number persisted in the database over configuration', async () => {
    const dbFile = path.join(dir, 'applications.db');
    const conn = new BetterSqlite3(dbFile);
    conn.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    conn.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('notification_number', '947700000001');
    conn.close();
    vi.mocked(loadConfig).mockReturnValueOnce({ whatsapp: cfg, adminWhatsappNumber: '94771234567', dataDir: dir } as ReturnType<typeof loadConfig>);
    const fetch = vi.fn().mockResolvedValue(new Response('{}')); vi.stubGlobal('fetch', fetch);
    await sendAdmin({ type: 'offline' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ to: '947700000001' });
  });
  it('reads no database when the database file is absent', async () => {
    vi.mocked(loadConfig).mockReturnValueOnce({ whatsapp: cfg, adminWhatsappNumber: null, dataDir: dir } as ReturnType<typeof loadConfig>);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await sendAdmin({ type: 'offline' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('no-ops when config or admin number is unset', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await sendAdmin({ type: 'offline' });
    await sendAdmin({ type: 'offline' }, cfg, '');
    await sendAdmin({ type: 'offline' }, cfg, '   ');
    await sendAdmin({ type: 'offline' }, { ...cfg, accessToken: '' }, '94771234567');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('propagates delivery failure so the caller can retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret-token', { status: 401 })));
    await expect(sendAdmin({ type: 'offline' }, cfg, '94771234567')).rejects.toThrow('HTTP 401');
  });
});
