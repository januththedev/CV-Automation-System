#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getReadonlyStatus } from '../api/admin-server.js';

const USAGE = 'usage: cv-auto status [--json] | diagnose [--json] | help\nRead-only local inspection; provider configuration is not live health.';

export interface CliOptions {
  dataDir?: string;
  sqlitePath?: string;
  log?: (line: string) => void;
}

export async function runCli(args: string[], options: CliOptions = {}): Promise<number> {
  const log = options.log ?? console.log;
  if (args.length === 0 || (args.length === 1 && ['help', '--help', '-h'].includes(args[0]))) {
    log(USAGE);
    return 0;
  }
  const [command, flag] = args;
  if (!['status', 'diagnose'].includes(command) || args.length > 2 || (flag !== undefined && flag !== '--json')) {
    log(USAGE);
    return 2;
  }
  try {
    const configDir = process.env.CV_CONFIG_DIR || './data/cv-auto';
    const dataDir = options.dataDir ?? (process.env.CV_DATA_DIR || path.join(configDir, '..', 'cv-auto-data'));
    const dbPath = options.sqlitePath ?? path.join(dataDir, 'applications.db');
    const state = getReadonlyStatus(dbPath);
    const database = state?.schemaReady ? 'ready' : fs.existsSync(dbPath) ? 'unavailable' : 'missing';
    const snapshot = {
      database, schemaReady: state?.schemaReady ?? false,
      totalApplications: state?.totalApplications ?? 0, pendingWork: state?.pendingWork ?? 0,
    };
    let providers: Record<string, { configured: boolean }> | undefined;
    if (command === 'diagnose') {
      let raw: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
      } catch { /* Missing or invalid configuration remains unconfigured. */ }
      const present = (section: string, key: string, env: string) => {
        const value = raw[section];
        const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return Boolean(process.env[env] || (typeof record[key] === 'string' && record[key]));
      };
      providers = {
        whatsapp: { configured: present('whatsapp', 'accessToken', 'CV_WHATSAPP_TOKEN') },
        openrouter: { configured: present('openrouter', 'apiKey', 'CV_OPENROUTER_KEY') },
        onedrive: { configured: present('onedrive', 'clientId', 'CV_ONEDRIVE_CLIENT_ID') },
        sheets: { configured: present('sheets', 'sheetId', 'CV_SHEET_ID') },
      };
    }
    if (flag === '--json') log(JSON.stringify({ ...snapshot, ...(providers ? { providers } : {}) }));
    else {
      log(`database: ${database}\napplications: ${snapshot.totalApplications}\npending work: ${snapshot.pendingWork}`);
      if (providers) {
        log('providers (configuration presence only; not live health):');
        for (const [name, value] of Object.entries(providers)) log(`${name}: ${value.configured ? 'configured' : 'unconfigured'}`);
        log('WhatsApp number: metadata only; CV phone number: separate. AI is extraction only, never controller.');
        log('Worker, Redis and provider connectivity: not checked.');
      }
    }
    return database === 'ready' ? 0 : 1;
  } catch {
    log(flag === '--json' ? '{"error":"Local inspection unavailable"}' : 'Local inspection unavailable');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void runCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('Local inspection unavailable');
    process.exitCode = 1;
  });
}
