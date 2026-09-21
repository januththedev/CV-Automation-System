import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Job } from 'bullmq';
import { QUEUES, type AppConfig } from '../../src/contracts.js';
import * as db from '../../src/database/db.js';
import { startWorkerRuntime, type WorkerRuntime } from '../index.js';
// Heavy googleapis/MSAL imports load under real timers, outside the test's frozen timers.
import '../pipeline/index.js';

const mocks = vi.hoisted(() => ({
  processors: new Map<string, (job: Job) => Promise<unknown>>(),
  add: vi.fn().mockResolvedValue({}),
  close: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('bullmq', () => ({ Worker: class {
  constructor(public name: string, processor: (job: Job) => Promise<unknown>) { mocks.processors.set(name, processor); }
  on() { return this; }
  async waitUntilReady() {}
  async run() {}
  close = mocks.close;
} }));
vi.mock('../../src/queue/queues.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/queue/queues.js')>();
  return { ...original,
    getQueues: () => Object.fromEntries(QUEUES.map(name => [name, { getJob: async () => undefined, add: mocks.add }])),
    enqueueJob: mocks.add,
    closeQueues: async () => {},
  };
});

let runtime: WorkerRuntime | undefined;
let dir: string | undefined;
afterEach(async () => {
  await runtime?.stop(); runtime = undefined;
  db.closeDb();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers(); vi.clearAllMocks(); mocks.processors.clear();
});

it('dispatches a durable inbound receipt through the default pipeline and stops its timers', { timeout: 90000 }, async () => {
  vi.useFakeTimers();
  dir = mkdtempSync(path.join(tmpdir(), 'cv-runtime-'));
  db.getDb(path.join(dir, 'applications.db'));
  const app = db.recordInbound({ wa_message_id: 'runtime-inbound', from_number: '+94771234567',
    from_jid: '94771234567@s.whatsapp.net', timestamp: new Date().toISOString(),
    type: 'text', text: 'Hello', media_id: null, media_filename: null, media_mime_type: null,
  }, 30).application;
  runtime = await startWorkerRuntime({ registerSignals: false,
    config: { dataDir: dir, redisUrl: 'redis://localhost:6379', sessionTimeoutMinutes: 30, mandatoryFields: ['name'] } as AppConfig,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(db.listPendingWork()).toEqual([]);
  expect(mocks.add).toHaveBeenCalledWith('cv-processing', expect.objectContaining({ applicationId: app.id, workId: expect.any(String) }), expect.objectContaining({ jobId: expect.stringMatching(/^inbound-/) }));
  await mocks.processors.get('cv-processing')!({ name: 'cv-processing', data: { applicationId: app.id }, opts: {}, attemptsMade: 0 } as Job);
  expect(mocks.add).toHaveBeenCalledWith('whatsapp-confirm', expect.objectContaining({ applicationId: app.id, to: app.whatsapp_number, purpose: 'greeting' }), expect.any(Object));
  await runtime.stop();
  expect(mocks.close).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
  const count = mocks.add.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120000);
  expect(mocks.add).toHaveBeenCalledTimes(count);
});
