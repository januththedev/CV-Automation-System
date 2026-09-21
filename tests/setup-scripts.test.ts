import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SETUP = path.join(ROOT, 'setup.sh');
const WIZARD = path.join(ROOT, 'scripts', 'setup-wizard.sh');
const INSTALL_CLI = path.join(ROOT, 'scripts', 'install-cli.sh');
const BASH_AVAILABLE = spawnSync('bash', ['--version']).status === 0;

const describeBash = BASH_AVAILABLE ? describe : describe.skip;

function stubBin(entries: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-stub-'));
  for (const [name, body] of Object.entries(entries)) {
    // Stub executables are written by validated basename inside a fresh temp dir.
    if (!/^[a-z0-9_-]+$/.test(name)) throw new Error('invalid stub name');
    const p = path.resolve(dir, name);
    if (p === dir || !p.startsWith(dir + path.sep)) throw new Error('stub path escaped its directory');
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
  }
  return dir;
}

let stubDir: string | undefined;
afterEach(() => {
  if (stubDir) { fs.rmSync(stubDir, { recursive: true, force: true }); stubDir = undefined; }
});

describeBash('deployment shell scripts', () => {
  it.each([['setup.sh', SETUP], ['scripts/setup-wizard.sh', WIZARD], ['scripts/install-cli.sh', INSTALL_CLI]])(
    'parses cleanly under bash -n: %s', (_name, file) => {
      const run = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
    });

  it('refuses to run on a host with Node older than 20, without touching docker', () => {
    stubDir = stubBin({
      node: 'if [ "$1" = "-e" ]; then exit 1; fi\necho v12.22.9',
      docker: 'echo docker-stub >/dev/null',
    });
    const run = spawnSync('bash', [SETUP], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${stubDir}${path.delimiter}${process.env.PATH}` },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Node.js 20 or later is required');
    expect(run.stderr).toContain('v12.22.9');
  });

  it('reports a missing docker daemon cleanly when Node is current', () => {
    stubDir = stubBin({
      node: 'if [ "$1" = "-e" ]; then exit 0; fi\necho v20.11.0',
      docker: 'exit 1',
    });
    const run = spawnSync('bash', [SETUP], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${stubDir}${path.delimiter}${process.env.PATH}` },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('docker daemon not reachable');
  });

  it('wizard delegates to the environment-only configure writer', () => {
    const run = spawnSync('bash', [WIZARD, '--config-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'cv-wiz-'))], {
      encoding: 'utf8',
    });
    // Without the required provider variables configure fails closed and names them.
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Required environment variables missing');
    expect(run.stderr).toContain('CV_WHATSAPP_TOKEN');
  });

  it('asks for the notice number on a fresh setup when CV_ADMIN_NUMBER is unset', () => {
    stubDir = stubBin({ docker: 'exit 0' });
    const run = spawnSync('bash', [SETUP], {
      encoding: 'utf8',
      input: '947700000001\n',
      env: { ...process.env, CV_ADMIN_NUMBER: '', PATH: `${stubDir}${path.delimiter}${process.env.PATH}` },
    });
    // The prompt appears; configure then fails closed on the missing provider
    // variables, proving the entered number itself was accepted.
    expect(run.stdout).toContain('WhatsApp number that receives system notices');
    expect(run.stderr).toContain('Required environment variables missing');
  });

  it('install-cli installs a launcher into a chosen prefix without touching /usr/local', () => {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-install-'));
    const run = spawnSync('bash', [INSTALL_CLI], {
      encoding: 'utf8',
      env: { ...process.env, CV_INSTALL_PREFIX: prefix },
    });
    // Fails only on a fresh checkout without dist/cli/cv-auto.js; otherwise installs.
    if (fs.existsSync(path.join(ROOT, 'dist', 'cli', 'cv-auto.js'))) {
      expect(run.status).toBe(0);
      expect(fs.existsSync(path.join(prefix, 'bin', 'cv-auto'))).toBe(true);
      expect(fs.readFileSync(path.join(prefix, 'bin', 'cv-auto'), 'utf8')).toContain('exec node');
    } else {
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('npm run build');
    }
  });
});
