import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../../src/contracts.js';
import * as db from '../../src/database/db.js';
import { startWorkerRuntime, type WorkerRuntime } from '../index.js';

const mocks = vi.hoisted(() => ({ add: vi.fn(), close: vi.fn(), getJob: vi.fn() }));
vi.mock('bullmq', () => ({ Worker: class {
  on() { return this; }
  async waitUntilReady() {}
  async run() {}
  close = mocks.close;
} }));
vi.mock('../../src/queue/queues.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/queue/queues.js')>(),
  getQueues: () => Object.fromEntries(['cv-processing', 'onedrive', 'google-sheets', 'whatsapp-confirm'].map(name => [name, { getJob: mocks.getJob, add: mocks.add }])),
  enqueueJob: mocks.add,
  closeQueues: async () => {},
}));
let runtime: WorkerRuntime | undefined;
let dir: string | undefined;
afterEach(async () => {
  await runtime?.stop(); runtime = undefined;
  db.closeDb();
  if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined;
  vi.useRealTimers(); vi.resetAllMocks();
});

it('rejects startup and closes workers when recovery publication fails', async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cv-recovery-'));
  db.getDb(path.join(dir, 'applications.db'));
  db.createApplication({ whatsapp_number: '+94771234567', whatsapp_jid: 'jid', status: 'COMPLETED' });
  mocks.add.mockRejectedValueOnce(new Error('private Redis credentials'));
  await expect(startWorkerRuntime({ registerSignals: false, processors: {}, config: {
    dataDir: dir, redisUrl: 'redis://localhost:6379', sessionTimeoutMinutes: 30,
  } as AppConfig })).rejects.toThrow('Startup recovery publication failed');
  expect(mocks.close).toHaveBeenCalledTimes(4);
});

it('recovers unsent completions and waiting details at startup and periodically with the same IDs', async () => {
  vi.useFakeTimers();
  dir = mkdtempSync(path.join(tmpdir(), 'cv-recovery-'));
  db.getDb(path.join(dir, 'applications.db'));
  const base = { whatsapp_number: '+94771234567', whatsapp_jid: 'jid', revision: 1, processed_revision: 1 };
  const complete = db.createApplication({ ...base, status: 'COMPLETED' });
  const waiting = db.createApplication({ ...base, status: 'WAITING_FOR_DETAILS' });
  runtime = await startWorkerRuntime({ registerSignals: false, processors: {}, config: {
    dataDir: dir, redisUrl: 'redis://localhost:6379', sessionTimeoutMinutes: 30,
  } as AppConfig });
  expect(runtime.recovered).toBe(2);
  for (const app of [complete, waiting]) expect(mocks.add).toHaveBeenCalledWith('cv-processing',
    { applicationId: app.id }, { jobId: `reconcile-${app.id}-1` });
  await vi.advanceTimersByTimeAsync(60000);
  expect(mocks.add).toHaveBeenCalledTimes(4);
  mocks.close.mockImplementation(async () => {
    expect(vi.getTimerCount()).toBe(0);
  });
  await runtime.stop();
  expect(vi.getTimerCount()).toBe(0);
});
