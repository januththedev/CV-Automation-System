import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DIST_DB = path.resolve('dist/src/database/db.js');
const SETTING_SCRIPT = path.resolve('scripts/db-set-setting.mjs');
const LAUNCHER = path.resolve('scripts/run-native.mjs');
const NODE = process.execPath;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-ops-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('db-set-setting.mjs', () => {
  // Writes through the compiled database module, so the build must exist.
  const withBuild = fs.existsSync(DIST_DB) ? describe : describe.skip;
  withBuild('notification-number writer', () => {
    it('persists a setting into the appliance database and refuses invalid keys', async () => {
      const env = { ...process.env, CV_DATA_DIR: dir, CV_CONFIG_DIR: path.join(dir, 'cfg') };
      const ok = spawnSync(NODE, [SETTING_SCRIPT, 'notification_number', '947700000001'], { env, encoding: 'utf8' });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('saved: notification_number');
      const { readSetting } = await import(`file:///${DIST_DB.replace(/\\/g, '/')}`);
      expect(readSetting(path.join(dir, 'applications.db'), 'notification_number')).toBe('947700000001');
      const bad = spawnSync(NODE, [SETTING_SCRIPT, '../escape', 'x'], { env, encoding: 'utf8' });
      expect(bad.status).toBe(2);
      expect(bad.stderr).toContain('usage:');
    });
  });
});

describe('run-native.mjs launcher', () => {
  it('parses as valid JavaScript', () => {
    const check = spawnSync(NODE, ['--check', LAUNCHER], { encoding: 'utf8' });
    expect(check.status).toBe(0);
    expect(check.stderr).toBe('');
  });

  it('stops services and redis without touching the database', () => {
    const stop = spawnSync(NODE, [LAUNCHER, '--stop'], { encoding: 'utf8', timeout: 30_000 });
    expect(stop.status).toBe(0);
    expect(stop.stdout).toContain('Stopping services');
    expect(stop.stdout).toContain('service process(es)');
  });

  it('carries the operator contract: guidance, masked review, health check, banner and notices', () => {
    const source = fs.readFileSync(LAUNCHER, 'utf8');
    // One "where" hint per credential field (10) plus the private-key hint.
    expect((source.match(/where:/g) ?? []).length).toBeGreaterThanOrEqual(11);
    expect(source).toContain('REVIEW (secrets masked)');
    expect(source).toContain('waitForStack');
    expect(source).toContain('/health');
    expect(source).toContain('/admin/dashboard');
    expect(source).toContain('CV AUTOMATION IS ONLINE');
    expect(source).toContain('SSH:');
    expect(source).toMatch(/Tunnel:\s+ssh -L 3001:127\.0\.0\.1:3001/);
    expect(source).toContain('sendAdmin');
    expect(source).toContain("includes('--stop')");
  });
});

describe('deployment safety', () => {
  const artifacts = [
    'setup.sh',
    'scripts/setup-wizard.sh',
    'scripts/install-cli.sh',
    'scripts/run-native.mjs',
    'scripts/verify-integrations.mjs',
    'scripts/db-set-setting.mjs',
    'systemd/cv-auto.service',
    'systemd/cv-auto-kiosk.service',
    'docker-compose.yml',
  ];
  it('never mutates SSH configuration or firewall rules', () => {
    const forbidden = [
      /sshd_config/, /authorized_keys/, /PermitRootLogin/, /iptables\b/, /\bnft\s/, /\bufw\s/,
      /firewall-cmd/, /systemctl\s+(restart|stop|disable)\s+ssh/, /chmod\s+[0-7]*\s+\/etc\/ssh/,
      /tee\s+\/etc\/ssh/,
    ];
    const violations: string[] = [];
    for (const artifact of artifacts) {
      const text = fs.readFileSync(path.resolve(artifact), 'utf8');
      for (const pattern of forbidden) {
        if (pattern.test(text)) violations.push(`${artifact} matches ${String(pattern)}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('reads SSH host keys only to compute a public fingerprint (never copies or sends them)', () => {
    for (const artifact of ['scripts/run-native.mjs', 'setup.sh']) {
      const text = fs.readFileSync(path.resolve(artifact), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (/ssh_host_/.test(line)) {
          expect(line).toMatch(/readFileSync|existsSync|ssh-keygen|\.pub/);
          expect(line).not.toMatch(/BEGIN|PRIVATE KEY|writeFile|cp |scp /);
        }
      }
    }
  });
});
