import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configure } from '../scripts/configure.mjs';

// Dummy values assembled at runtime: no usable credential literals in tests.
const dummy = (...parts: string[]) => parts.join('-');
const REQUIRED_ENV: Record<string, string> = {
  CV_WHATSAPP_TOKEN: dummy('synthetic', 'token'),
  CV_WHATSAPP_PHONE_ID: '111111111111111',
  CV_WHATSAPP_WABA_ID: '222222222222222',
  CV_WHATSAPP_VERIFY_TOKEN: dummy('synthetic', 'verify'),
  CV_WHATSAPP_APP_SECRET: dummy('synthetic', 'secret'),
  CV_OPENROUTER_KEY: dummy('synthetic', 'openrouter'),
  CV_SHEET_ID: dummy('synthetic', 'sheet'),
  CV_SHEETS_SERVICE_ACCOUNT_EMAIL: 'svc@synthetic.invalid',
  CV_SHEETS_PRIVATE_KEY: dummy('synthetic', 'private', 'key'),
  CV_ONEDRIVE_CLIENT_ID: dummy('synthetic', 'client', 'id'),
  CV_ADMIN_NUMBER: '947700000001',
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-configure-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('configure.mjs runtime.env writer', () => {
  it('writes runtime.env exclusively from environment variables, 0600 on POSIX', () => {
    const multilineKey = ['line1', 'line2'].join(String.fromCharCode(10));
    const target = configure(dir, { ...REQUIRED_ENV, CV_SHEETS_PRIVATE_KEY: multilineKey });
    const stat = fs.statSync(target);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    const content = fs.readFileSync(target, 'utf8');
    expect(content).toContain(`CV_WHATSAPP_TOKEN=${REQUIRED_ENV.CV_WHATSAPP_TOKEN}`);
    expect(content).toContain('CV_SHEETS_PRIVATE_KEY=line1\\nline2');
    expect(content).toContain('CV_OPENROUTER_MODEL=google/gemini-3.8-flash');
    expect(content).toMatch(/^CV_ADMIN_TOKEN=[A-Za-z0-9_-]{24,256}$/m);
  });

  it('generates a high-entropy admin token that is never echoed', () => {
    const target = configure(dir, REQUIRED_ENV);
    const content = fs.readFileSync(target, 'utf8');
    const token = content.match(/^CV_ADMIN_TOKEN=(.+)$/m)![1];
    expect(token.length).toBeGreaterThanOrEqual(24);
    expect(new Set(token).size).toBeGreaterThanOrEqual(8);
    expect(content).not.toContain('synthetic-token'.repeat(2));
  });

  it('honors an operator-supplied CV_ADMIN_TOKEN and rejects weak ones', () => {
    const content = fs.readFileSync(
      configure(dir, { ...REQUIRED_ENV, CV_ADMIN_TOKEN: 'operator-chosen-high-entropy-token-01' }),
      'utf8',
    );
    expect(content).toContain('CV_ADMIN_TOKEN=operator-chosen-high-entropy-token-01');
    expect(() => configure(path.join(dir, 'weak-short'), { ...REQUIRED_ENV, CV_ADMIN_TOKEN: 'short' }))
      .toThrow(/high-entropy/);
    expect(() => configure(path.join(dir, 'weak-repeat'), { ...REQUIRED_ENV, CV_ADMIN_TOKEN: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }))
      .toThrow(/high-entropy/);
  });

  it('refuses to overwrite an existing runtime.env', () => {
    configure(dir, REQUIRED_ENV);
    expect(() => configure(dir, REQUIRED_ENV)).toThrow(/preserved/);
  });

  it('rejects NUL or embedded newlines in any value', () => {
    expect(() => configure(dir, { ...REQUIRED_ENV, CV_DEVICE_NAME: 'a\nb' }))
      .toThrow(/newline or NUL/);
    expect(() => configure(dir, { ...REQUIRED_ENV, CV_WHATSAPP_VERIFY_TOKEN: 'a\0b' }))
      .toThrow(/newline or NUL/);
  });

  it('fails closed naming every missing required variable', () => {
    const partial = { ...REQUIRED_ENV };
    delete partial.CV_WHATSAPP_APP_SECRET;
    delete partial.CV_ADMIN_NUMBER;
    expect(() => configure(dir, partial)).toThrow(/CV_WHATSAPP_APP_SECRET, CV_ADMIN_NUMBER/);
    expect(fs.existsSync(path.join(dir, 'runtime.env'))).toBe(false);
  });
});
