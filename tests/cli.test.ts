import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as database from '../src/database/db.js';
import { runCli } from '../cli/cv-auto.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-cli-'));
});
afterEach(() => {
  database.closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});
function writeDb(): void {
  database.getDb(path.join(dir, 'applications.db'));
  database.createApplication({
    whatsapp_jid: '94771234567@s.whatsapp.net', whatsapp_number: '94771234567',
    status: 'COMPLETED',
  });
  database.closeDb();
}
async function run(args: string[], env: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (k === 'CV_CONFIG_DIR' || k === 'CV_DATA_DIR' || k === 'SQLITE_PATH') {
      if (v === undefined) vi.stubEnv(k, ''); else vi.stubEnv(k, v);
    }
  }
  return runCli(args, {
    dataDir: env['CV_DATA_DIR'] ?? dir,
    sqlitePath: env['SQLITE_PATH'],
    log: (line) => out.push(line),
  });
}
let out: string[];

describe('cv-auto CLI', () => {
  it('status reports readonly counts without creating a database or schema', async () => {
    out = [];
    const code = await run(['status']);
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('database: missing');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('status reads an existing database without writes (no -wal creation)', async () => {
    out = [];
    writeDb();
    const code = await run(['status']);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('database: ready');
    expect(text).toContain('applications: 1');
    expect(text).not.toContain('94771234567@s.whatsapp.net');
  });

  it('status accepts --json output with bounded shape', async () => {
    out = [];
    writeDb();
    const code = await run(['status', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join('\n'));
    expect(Object.keys(parsed).sort()).toEqual(['database', 'pendingWork', 'schemaReady', 'totalApplications']);
    expect(parsed.database).toBe('ready');
  });

  it('status rejects an unknown status argument value shape', async () => {
    out = [];
    const code = await run(['status', 'extra-positional']);
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('usage');
  });

  it('diagnose reports readonly DB and config/provider presence, never secret values', async () => {
    out = [];
    writeDb();
    vi.stubEnv('CV_CONFIG_DIR', dir);
    vi.stubEnv('CV_WHATSAPP_TOKEN', 'PRIVATE-WA-TOKEN');
    vi.stubEnv('CV_OPENROUTER_KEY', 'PRIVATE-OR-KEY');
    const code = await run(['diagnose']);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('providers');
    expect(text).toContain('whatsapp: configured');
    expect(text).toContain('openrouter: configured');
    expect(text).toContain('sheets: unconfigured');
    expect(text).not.toContain('PRIVATE-WA-TOKEN');
    expect(text).not.toContain('PRIVATE-OR-KEY');
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false);
  });

  it('diagnose never performs network calls or shell control', async () => {
    out = [];
    writeDb();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network access'));
    const spawn = vi.spyOn((await import('node:child_process')).default, 'spawn').mockImplementation(() => {
      throw new Error('Unexpected process spawn');
    });
    const spawnSync = vi.spyOn((await import('node:child_process')).default, 'spawnSync').mockImplementation(() => {
      throw new Error('Unexpected process spawnSync');
    });
    await run(['diagnose']);
    await run(['status']);
    expect(fetch).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('help lists status/diagnose and exits 0', async () => {
    out = [];
    const code = await run(['help']);
    expect(code).toBe(0);
    const text = out.join('\n');
    for (const cmd of ['status', 'diagnose', 'help']) expect(text).toContain(cmd);
  });

  it('unknown command exits 2 with usage on stderr-joined output', async () => {
    out = [];
    const code = await run(['deploy']);
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('usage');
  });
});
