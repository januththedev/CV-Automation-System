import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Job, JobsOptions } from 'bullmq';
import type { AppConfig, ExtractedCandidate, InboundMessage, QueueName } from '../../../src/contracts.js';
import { QUEUES } from '../../../src/contracts.js';
import * as db from '../../../src/database/db.js';
import type { ProcessorRegistry, WorkerContext } from '../../worker-context.js';
import { DocumentReviewNeededError } from '../../../src/ai/document.js';
import { createPipelineProcessors } from '../index.js';

const mocks = vi.hoisted(() => ({
  download: vi.fn(), read: vi.fn(), extract: vi.fn(), send: vi.fn(), upload: vi.fn(), folder: vi.fn(),
  link: vi.fn(), headers: vi.fn(), row: vi.fn(), admin: vi.fn(), whatsappConstructor: vi.fn(),
}));
vi.mock('../../../src/integrations/whatsapp/client.js', () => ({
  downloadMedia: mocks.download,
  WhatsAppClient: class { constructor(config: unknown) { mocks.whatsappConstructor(config); } sendText = mocks.send; },
}));
vi.mock('../../../src/integrations/onedrive/client.js', () => ({
  OneDriveClient: class { ensureFolder = mocks.folder; uploadFile = mocks.upload; createShareLink = mocks.link; },
}));
vi.mock('../../../src/integrations/google-sheets/client.js', () => ({
  SheetsClient: class { ensureHeaderRow = mocks.headers; writeApplicationRow = mocks.row; },
}));
vi.mock('../../../src/integrations/openrouter/extract.js', () => ({ extractCandidateData: mocks.extract }));
vi.mock('../../../src/ai/document.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/ai/document.js')>(), readDocument: mocks.read,
}));
vi.mock('../../../src/services/notify.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/services/notify.js')>(), sendAdmin: mocks.admin,
}));

const original = Buffer.from('Original untouched CV bytes\n');
const candidate: ExtractedCandidate = {
  name: 'Jane Doe', nic: '199012345678', address: 'Colombo', cv_phone_number: '+94779999999', profession: 'Engineer',
  cv_present: true, cv_filename: 'Jane.pdf', missing_fields: [], needs_review: false, review_reason: null, source: {},
};
type Pending = { queue: QueueName; data: Record<string, unknown>; opts: JobsOptions; state: string };
let directory: string;
let config: AppConfig;
let context: WorkerContext;
let processors: ProcessorRegistry;
let pending: Pending[];
let allJobs: Map<string, Pending>;
let sequence = 0;
function job(data: object, attemptsMade = 0, attempts = 5): Job {
  return { name: 'process', data, attemptsMade, opts: { attempts } } as Job;
}
function inbound(type: 'text' | 'document' = 'document', text: string | null = null, number = '+94771234567'): db.DatabaseApplication {
  const message: InboundMessage = {
    wa_message_id: `inbound-${++sequence}`, from_number: number, from_jid: `${number}@s.whatsapp.net`, timestamp: new Date().toISOString(), type, text,
    media_id: type === 'document' ? `media-${sequence}` : null, media_filename: type === 'document' ? '../Jane.pdf' : null,
    media_mime_type: type === 'document' ? 'application/pdf' : null,
  };
  return db.recordInbound(message, 30).application;
}
async function runNext(queue?: QueueName): Promise<Pending> {
  const index = pending.findIndex(entry => !queue || entry.queue === queue);
  if (index < 0) throw new Error('No queued job');
  const next = pending.splice(index, 1)[0];
  next.state = 'active';
  try { await processors[next.queue](job(next.data)); next.state = 'completed'; }
  catch (error) { next.state = 'failed'; throw error; }
  return next;
}
async function drain(): Promise<void> {
  let max = 30;
  while (pending.length && max-- > 0) await runNext();
  expect(pending).toHaveLength(0);
}
async function complete(app: db.DatabaseApplication): Promise<db.DatabaseApplication> {
  await processors['cv-processing'](job({ applicationId: app.id }));
  await drain();
  return db.getApplicationById(app.id)!;
}

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), 'cv-pipeline-'));
  db.getDb(':memory:');
  config = {
    deviceName: 'Test', dataDir: directory, configDir: directory, logDir: directory, sessionTimeoutMinutes: 30,
    redisUrl: 'redis://localhost:6379', apiPort: 3000, adminWhatsappNumber: '+94771111111', dashboardUrl: null,
    mandatoryFields: ['name', 'cv_phone_number'], whatsapp: { accessToken: 'SECRET', verifyToken: 'VERIFY', phoneNumberId: '123', wabaId: '456' },
    onedrive: { clientId: 'client', folderRoot: 'CV Applications', tokenCachePath: 'unused' },
    sheets: { serviceAccountEmail: 'unused', privateKey: 'SECRET_KEY', sheetId: 'sheet' },
    openrouter: { apiKey: process.env.TEST_OPENROUTER_API_KEY ?? 'synthetic-test-key', model: 'test' },
  };
  pending = []; allJobs = new Map();
  const queues = Object.fromEntries(QUEUES.map(queue => [queue, {
    getJob: vi.fn(async (id: string) => {
      const existing = allJobs.get(`${queue}-${id}`);
      return existing ? { getState: async () => existing.state, retry: async () => { existing.state = 'waiting'; pending.push(existing); } } : undefined;
    }),
    add: vi.fn(async (_name: string, data: Record<string, unknown>, opts: JobsOptions) => {
      const entry = { queue, data, opts, state: 'waiting' };
      allJobs.set(`${queue}-${opts.jobId}`, entry); pending.push(entry); return entry;
    }),
  }]));
  context = { config, db: db.getDb(), queues } as unknown as WorkerContext;
  processors = createPipelineProcessors(context);
  mocks.download.mockResolvedValue({ buffer: original, filename: 'media.pdf', mimeType: 'application/pdf' });
  mocks.read.mockResolvedValue('Jane Doe CV'); mocks.extract.mockResolvedValue({ ...candidate });
  mocks.folder.mockResolvedValue(undefined); mocks.upload.mockResolvedValue({ fileId: 'file-1' });
  mocks.link.mockResolvedValue('https://onedrive.example/view'); mocks.headers.mockResolvedValue(undefined);
  mocks.row.mockResolvedValue({ row: 2 }); mocks.send.mockResolvedValue(undefined); mocks.admin.mockResolvedValue(undefined);
});
afterEach(async () => { db.closeDb(); await rm(directory, { recursive: true, force: true }); });

describe('document queue pipeline', () => {
  it.each([
    ['COMPLETED', 1], ['WAITING_FOR_DETAILS', 1],
    ['COMPLETED', 0], ['WAITING_FOR_DETAILS', 0],
  ] as const)('recovers %s outbound work without document metadata (processed %s)', async (status, processedRevision) => {
    const app = db.createApplication({ whatsapp_number: '+94771234567', whatsapp_jid: 'jid',
      status, revision: 1, processed_revision: processedRevision });
    await processors['cv-processing'](job({ applicationId: app.id }));
    expect(pending).toHaveLength(1);
    expect(pending[0].data.purpose).toBe(status === 'COMPLETED' ? 'confirmation' : 'details');
    await drain();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    await processors['cv-processing'](job({ applicationId: app.id }));
    expect(pending).toHaveLength(0);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('completes a document with exact confirmation, full conversation and metadata-only WhatsApp identity', async () => {
    inbound('text', 'My address is Colombo');
    const app = inbound('document', 'Here is my CV');
    const result = await complete(app);
    expect(result).toMatchObject({ status: 'COMPLETED', processed_revision: app.revision, confirmation_sent: true,
      sheet_row_number: 2, whatsapp_number: '+94771234567', cv_phone_number: '+94779999999', onedrive_url: 'https://onedrive.example/view' });
    expect(await readFile(result.cv_local_path!)).toEqual(original);
    expect(path.basename(result.cv_local_path!)).toBe('Jane.pdf');
    expect(result.cv_local_path).toContain(path.join(directory, 'cv-files', app.id));
    expect(mocks.extract.mock.calls[0][0].messages.map((value: { text: string }) => value.text)).toEqual(['My address is Colombo', 'Here is my CV']);
    expect(mocks.send).toHaveBeenCalledWith('+94771234567', 'Your application has been received successfully. Thank you.');
    expect(mocks.whatsappConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.whatsappConstructor).toHaveBeenCalledWith(config.whatsapp);
    expect(mocks.row.mock.calls[0][0]).toMatchObject({ status: 'COMPLETED', whatsapp_number: '+94771234567' });
  });

  it('asks ONLY for missing mandatory fields and waits for the next revision', async () => {
    mocks.extract.mockResolvedValue({ ...candidate, name: null, address: null, needs_review: true, missing_fields: ['name', 'address'] });
    const app = inbound();
    await complete(app);
    expect(db.getApplicationById(app.id)).toMatchObject({ status: 'WAITING_FOR_DETAILS', processed_revision: app.revision, name: null });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(app.whatsapp_number, 'Please provide the following missing details: full name. Thank you.');
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(db.getApplicationById(app.id)!.extraction_json).not.toBeNull();
    mocks.extract.mockResolvedValue(candidate);
    const details = inbound('text', 'My full name is Jane Doe');
    await complete(details);
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.extract.mock.calls[1][0].messages).toEqual([{ text: 'My full name is Jane Doe', at: expect.any(String) }]);
    expect(db.getApplicationById(app.id)).toMatchObject({ status: 'COMPLETED', processed_revision: details.revision });
  });

  it('flags duplicates for review without merging or uploading', async () => {
    const earlier = db.createApplication({ whatsapp_jid: 'old', whatsapp_number: '+94773333333', nic: candidate.nic });
    const app = inbound();
    await complete(app);
    expect(db.getApplicationById(app.id)).toMatchObject({ status: 'NEEDS_REVIEW', review: true, duplicate_of: earlier.id, error: 'DUPLICATE_MATCH', processed_revision: app.revision });
    expect(mocks.admin).toHaveBeenCalledWith({ type: 'review', appId: app.id, missing: [] }, config.whatsapp, config.adminWhatsappNumber);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(db.getApplicationById(earlier.id)!.name).toBeNull();
  });

  it.each(['TOO_LARGE', 'OCR_REQUIRED', 'UNSUPPORTED_FORMAT', 'INVALID_DOCUMENT', 'READ_FAILED', 'PARSER_UNAVAILABLE', 'TIMEOUT'] as const)(
    'routes document reader %s to review with a safe reason', async code => {
      mocks.read.mockRejectedValue(new DocumentReviewNeededError(code, 'PRIVATE RAW ERROR SECRET'));
      const app = inbound(); await complete(app);
      expect(db.getApplicationById(app.id)).toMatchObject({ status: 'NEEDS_REVIEW', review: true, error: `DOCUMENT_${code}`, processed_revision: app.revision });
      expect(mocks.extract).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
    });

  it('replays every queue without duplicate uploads, sheet writes or confirmations', async () => {
    const app = inbound(); await complete(app);
    for (const queue of ['cv-processing', 'onedrive', 'google-sheets'] as const) await processors[queue](job({ applicationId: app.id }));
    await processors['whatsapp-confirm'](job({ applicationId: app.id, revision: app.revision, purpose: 'confirmation', to: 'not metadata', body: 'wrong text' }));
    await drain();
    expect(mocks.download).toHaveBeenCalledTimes(1); expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(mocks.upload).toHaveBeenCalledTimes(1); expect(mocks.link).toHaveBeenCalledTimes(1);
    expect(mocks.row).toHaveBeenCalledTimes(1); expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('resumes link and sheet failures from checkpoints', async () => {
    const app = inbound(); await processors['cv-processing'](job({ applicationId: app.id }));
    mocks.link.mockRejectedValueOnce(new Error('SECRET TOKEN'));
    await expect(runNext('onedrive')).rejects.toThrow('ONEDRIVE operation failed');
    expect(db.getApplicationById(app.id)!.status).toBe('RETRY_PENDING');
    await processors.onedrive(job({ applicationId: app.id }));
    mocks.row.mockRejectedValueOnce(new Error('SECRET KEY'));
    await expect(runNext('google-sheets')).rejects.toThrow('SHEETS operation failed');
    await processors['google-sheets'](job({ applicationId: app.id })); await drain();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.headers).toHaveBeenCalledTimes(1);
    expect(db.getApplicationById(app.id)!.status).toBe('COMPLETED');
  });

  it('reprocesses replacement CV despite retaining the previous sheet row', async () => {
    const app = inbound(); const first = await complete(app);
    mocks.download.mockResolvedValue({ buffer: Buffer.from('Replacement original'), filename: 'Jane.pdf', mimeType: 'application/pdf' });
    mocks.link.mockResolvedValue('https://onedrive.example/replacement');
    const replacement = inbound(); expect(replacement.sheet_row_number).toBe(2);
    const second = await complete(replacement);
    expect(second.cv_local_path).not.toBe(first.cv_local_path);
    expect(await readFile(first.cv_local_path!)).toEqual(original);
    expect(await readFile(second.cv_local_path!)).toEqual(Buffer.from('Replacement original'));
    expect(mocks.download).toHaveBeenCalledTimes(2); expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(mocks.upload).toHaveBeenCalledTimes(2); expect(mocks.row).toHaveBeenCalledTimes(2);
    expect(mocks.headers).toHaveBeenCalledTimes(1); expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(second.processed_revision).toBe(replacement.revision);
  });

  it('records exhausted failures without raw provider errors or erasing candidates', async () => {
    const app = inbound(); db.updateApplication(app.id, { name: 'Existing candidate' });
    mocks.download.mockRejectedValue(new Error('Bearer SECRET provider raw body'));
    await expect(processors['cv-processing'](job({ applicationId: app.id }, 4))).rejects.toThrow('DOCUMENT operation failed');
    expect(db.getApplicationById(app.id)).toMatchObject({ status: 'FAILED', review: true, name: 'Existing candidate', processed_revision: app.revision, error: 'DOCUMENT_FAILED' });
    expect(mocks.admin.mock.calls[0][0]).toEqual({ type: 'failed', appId: app.id, error: 'processing' });
  });

  it('retries outbound confirmation and checkpoints only actual delivery', async () => {
    const app = inbound(); await processors['cv-processing'](job({ applicationId: app.id }));
    await runNext('onedrive'); await runNext('google-sheets');
    expect(db.getApplicationById(app.id)!.confirmation_sent).toBe(false);
    const outbound = pending.find(entry => entry.queue === 'whatsapp-confirm')!;
    mocks.send.mockRejectedValueOnce(new Error('SECRET'));
    await expect(runNext('whatsapp-confirm')).rejects.toThrow('WHATSAPP operation failed');
    expect(db.getApplicationById(app.id)).toMatchObject({ status: 'COMPLETED', confirmation_sent: false, error: 'WHATSAPP_RETRY' });
    await processors['whatsapp-confirm'](job(outbound.data, 1));
    expect(db.getApplicationById(app.id)).toMatchObject({ status: 'COMPLETED', confirmation_sent: true });
    expect(mocks.row).toHaveBeenCalledTimes(1);
  });

  it.each(['confirmation', 'details', 'greeting'] as const)('recovers retryable %s delivery after queue loss', async purpose => {
    if (purpose === 'details') mocks.extract.mockResolvedValue({ ...candidate, name: null });
    const app = inbound(purpose === 'greeting' ? 'text' : 'document', 'Hello');
    await processors['cv-processing'](job({ applicationId: app.id }));
    if (purpose === 'confirmation') {
      await runNext('onedrive'); await runNext('google-sheets');
    }
    mocks.send.mockRejectedValueOnce(new Error('private provider failure'));
    await expect(runNext('whatsapp-confirm')).rejects.toThrow('WHATSAPP operation failed');
    pending.length = 0;
    allJobs.clear();
    processors = createPipelineProcessors(context);
    const recovery = db.listRecoveryApplications();
    expect(recovery.map(row => row.id)).toContain(app.id);
    for (const row of recovery) await processors['cv-processing'](job({ applicationId: row.id }));
    expect(pending).toHaveLength(1);
    expect(pending[0].data.purpose).toBe(purpose);
    await drain();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    // Queue loss after the document stage completed must NOT repeat the
    // external side effects: one download, one upload, one link, one sheet row.
    if (purpose === 'confirmation') {
      expect(mocks.download).toHaveBeenCalledTimes(1);
      expect(mocks.upload).toHaveBeenCalledTimes(1);
      expect(mocks.link).toHaveBeenCalledTimes(1);
      expect(mocks.row).toHaveBeenCalledTimes(1);
    }
    await processors['cv-processing'](job({ applicationId: app.id }));
    expect(pending).toHaveLength(0);
  });

  it('marks an exhausted outbound failure FAILED and notifies the admin', async () => {
    const app = inbound(); await processors['cv-processing'](job({ applicationId: app.id }));
    await runNext('onedrive'); await runNext('google-sheets');
    const outbound = pending.pop()!;
    mocks.send.mockRejectedValue(new Error('API_KEY=PRIVATE'));
    await expect(processors['whatsapp-confirm'](job(outbound.data, 4))).rejects.toThrow('WHATSAPP operation failed');
    expect(db.getApplicationById(app.id)).toMatchObject({ status: 'FAILED', confirmation_sent: false, review: true });
    expect(mocks.admin.mock.calls[0][0]).toEqual({ type: 'failed', appId: app.id, error: 'processing' });
  });

  it('does not overwrite a newer inbound revision after an awaited provider response', async () => {
    const app = inbound();
    let replacement: db.DatabaseApplication | undefined;
    mocks.download.mockImplementationOnce(async () => {
      replacement = inbound();
      return { buffer: original, filename: 'Jane.pdf', mimeType: 'application/pdf' };
    });
    await processors['cv-processing'](job({ applicationId: app.id }));
    expect(db.getApplicationById(app.id)).toMatchObject({ revision: replacement!.revision, status: 'DOCUMENT_RECEIVED', cv_local_path: null, processed_revision: 0 });
    expect(mocks.extract).not.toHaveBeenCalled();
    await complete(replacement!);
    expect(db.getApplicationById(app.id)!.status).toBe('COMPLETED');
  });

  it('ignores stale downstream and outbound jobs for replacement documents', async () => {
    const app = inbound(); await processors['cv-processing'](job({ applicationId: app.id }));
    inbound();
    await runNext('onedrive');
    await processors['whatsapp-confirm'](job({ applicationId: app.id, revision: app.revision, purpose: 'confirmation', to: app.whatsapp_number, body: 'bad' }));
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });

  it('serializes concurrent replays for one application', async () => {
    const app = inbound();
    await Promise.all([processors['cv-processing'](job({ applicationId: app.id })), processors['cv-processing'](job({ applicationId: app.id }))]);
    await drain();
    expect(mocks.extract).toHaveBeenCalledTimes(1); expect(mocks.upload).toHaveBeenCalledTimes(1); expect(mocks.row).toHaveBeenCalledTimes(1);
  });
});

describe('text-only sessions', () => {
  it('sends a greeting once, checkpoints after delivery, and ignores unsolicited text', async () => {
    const app = inbound('text', 'Hello');
    await processors['cv-processing'](job({ applicationId: app.id }));
    expect(db.getSession(app.whatsapp_number)!.greeting_sent).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
    await drain();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(app.whatsapp_number, 'Thank you for your interest. Please send your CV and any additional details you would like us to consider.');
    expect(db.getSession(app.whatsapp_number)!.greeting_sent).toBe(true);
    const next = inbound('text', 'Thanks'); await processors['cv-processing'](job({ applicationId: next.id })); await drain();
    expect(mocks.send).toHaveBeenCalledTimes(1); expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('uses the session checkpoint across greeting jobs with different inbound revisions', async () => {
    const app = inbound('text', 'Hello'); await processors['cv-processing'](job({ applicationId: app.id }));
    const next = inbound('text', 'Are you there?'); await processors['cv-processing'](job({ applicationId: next.id }));
    await drain(); expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});
