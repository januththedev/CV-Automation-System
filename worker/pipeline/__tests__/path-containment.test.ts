import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { applicationDirectory, safeFilename } from '../types.js';

const context = { config: { dataDir: '/srv/cv-data' }, queues: {}, db: {} } as never;

describe('candidate-controlled path construction', () => {
  it.each([
    '../../etc/passwd',
    '..\\..\\windows\\system32\\config',
    '/etc/shadow',
    'C:\\Windows\\win.ini',
    '....//....//escape',
    '..',
    '.',
    '\0../secret',
    'dir/../../../data/cv.pdf',
    'foo/bar/baz.pdf',
  ])('keeps filename %j inside the application directory', input => {
    const resolved = path.resolve(path.join(applicationDirectory(context, 'APP-2026-000001'), 'abc123', safeFilename(input)));
    expect(resolved.startsWith(path.resolve('/srv/cv-data/cv-files/APP-2026-000001') + path.sep)).toBe(true);
  });

  it('rejects traversal even for malformed queued application IDs', () => {
    for (const id of ['../escape', 'a/b', 'a\\b', '', '.', '..', 'APP-2026-000001\n']) {
      expect(() => applicationDirectory(context, id)).toThrow('Invalid application identifier');
    }
    expect(applicationDirectory(context, 'APP-2026_1')).toBe(path.resolve('/srv/cv-data/cv-files/APP-2026_1'));
  });

  it('falls back to a safe default for empty, dotted, reserved, and control-character names', () => {
    expect(safeFilename('')).toBe('cv.bin');
    expect(safeFilename('..')).toBe('cv.bin');
    expect(safeFilename('...')).toBe('cv.bin');
    expect(safeFilename('CON.pdf')).toBe('_CON.pdf');
    expect(safeFilename('cv\u0000.pdf')).toBe('cv_.pdf');
    expect(safeFilename('trailing. .')).toBe('trailing');
    expect(safeFilename('a'.repeat(300)).length).toBeLessThanOrEqual(180);
  });
});
