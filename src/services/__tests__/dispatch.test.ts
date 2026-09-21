import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../../contracts.js';
import * as db from '../../database/db.js';
import { enqueueJob, getQueues } from '../../queue/queues.js';
import { logger } from '../../logger.js';
import { ingestInboundMessage, startInboundDispatcher } from '../dispatch.js';

vi.mock('../../queue/queues.js', () => ({ enqueueJob: vi.fn(), getQueues: vi.fn() }));
vi.mock('../../logger.js', () => ({ logger: { error: vi.fn() } }));
const context = { config: { sessionTimeoutMinutes: 30, redisUrl: 'redis://localhost:6379' } };
const message = (id: string, document = false): InboundMessage => ({
  wa_message_id: id, from_number: '+94771234567', from_jid: '94771234567@s.whatsapp.net',
  timestamp: new Date().toISOString(), type: document ? 'document' : 'text',
  text: 'Use +19999999999 instead', media_id: document ? 'media-1' : null,
  media_filename: document ? 'CV.pdf' : null, media_mime_type: document ? 'application/pdf' : null,
});
let stop: (() => Promise<void>) | undefined;
const getJob = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-17T12:00:00Z'));
  vi.clearAllMocks();
  vi.mocked(enqueueJob).mockResolvedValue({} as never);
  getJob.mockReset().mockResolvedValue(undefined);
  vi.mocked(getQueues).mockReturnValue({ 'cv-processing': { getJob } } as never);
  db.getDb(':memory:');
});
afterEach(async () => {
  await stop?.(); stop = undefined;
  db.closeDb(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe('inbound ingestion', () => {
  it('publishes text once, acknowledges after enqueue, and preserves metadata on replay', async () => {
    const msg = message('replay');
    const mark = vi.spyOn(db, 'markWorkDispatched');
    vi.mocked(enqueueJob).mockImplementationOnce(async () => {
      expect(db.listPendingWork()).toHaveLength(1);
      expect(mark).not.toHaveBeenCalled();
      return {} as never;
    });
    const result = await ingestInboundMessage(context, msg);
    const work = db.getPendingWorkByMessageId(msg.wa_message_id)!;
    expect(enqueueJob).toHaveBeenCalledWith('cv-processing', {
      applicationId: result.application.id, workId: String(work.id), revision: 1,
    }, { jobId: `inbound-${work.id}` });
    expect(mark.mock.results.map(r => r.value)).toEqual([true]);
    expect(db.markGreetingSent(msg.from_number, result.application.id)).toBe(true);
    const replay = await ingestInboundMessage(context, msg);
    expect(replay.duplicate).toBe(true);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(mark.mock.results.map(r => r.value)).toEqual([true, false]);
    expect(db.markGreetingSent(msg.from_number, result.application.id)).toBe(false);
    expect(db.getSession(msg.from_number)?.greeting_sent).toBe(true);
    expect(result.application.whatsapp_number).toBe(msg.from_number);
    expect(db.listApplicationMessages(result.application.id)).toHaveLength(1);
  });

  it('keeps failed publication unacknowledged even after a duplicate arrives', async () => {
    const msg = message('failed');
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error('private connection details'));
    await expect(ingestInboundMessage(context, msg)).rejects.toThrow();
    await ingestInboundMessage(context, msg);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(db.listPendingWork()).toHaveLength(1);
    expect(db.markWorkDispatched(db.getPendingWorkByMessageId(msg.wa_message_id)!.id)).toBe(true);
  });

  it('does not acknowledge a replay while its original enqueue is still in flight', async () => {
    let resolve!: (value: never) => void;
    vi.mocked(enqueueJob).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const msg = message('in-flight');
    const pending = ingestInboundMessage(context, msg);
    await ingestInboundMessage(context, msg);
    expect(db.listPendingWork()).toHaveLength(1);
    resolve({} as never); await pending;
    expect(db.listPendingWork()).toEqual([]);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
  });

  it('publishes every new text and document message', async () => {
    await ingestInboundMessage(context, message('text'));
    await ingestInboundMessage(context, message('document', true));
    await ingestInboundMessage(context, message('details'));
    expect(enqueueJob).toHaveBeenCalledTimes(3);
    expect(db.listPendingWork()).toEqual([]);
  });
});

describe('dispatcher lifecycle', () => {
  it('has no import-time timers and republishes an unacknowledged row on startup', async () => {
    expect(vi.getTimerCount()).toBe(0);
    db.recordInbound(message('outbox'), 30);
    stop = startInboundDispatcher(context);
    await vi.advanceTimersByTimeAsync(0);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(db.listPendingWork()).toEqual([]);
    await vi.advanceTimersByTimeAsync(15000);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    await stop(); await stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for an in-flight enqueue on stop without scheduling another pass', async () => {
    db.recordInbound(message('shutdown'), 30);
    let resolve!: (value: never) => void;
    vi.mocked(enqueueJob).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    stop = startInboundDispatcher(context);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = vi.fn();
    const shutdown = stop().then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    expect(db.listPendingWork()).toHaveLength(1);
    resolve({} as never);
    await shutdown;
    expect(db.listPendingWork()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs without raw errors, retries publication next poll, and does not ack failure', async () => {
    db.recordInbound(message('retry'), 30);
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error('secret-token body'));
    stop = startInboundDispatcher(context);
    await vi.advanceTimersByTimeAsync(0);
    expect(db.listPendingWork()).toHaveLength(1);
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('secret-token');
    await vi.advanceTimersByTimeAsync(5000);
    expect(db.listPendingWork()).toEqual([]);
    expect(enqueueJob).toHaveBeenCalledTimes(2);
  });

  it('continues after a DB read failure and supports a configurable polling interval', async () => {
    db.recordInbound(message('read-retry'), 30);
    vi.spyOn(db, 'listPendingWork').mockImplementationOnce(() => { throw new Error('read failure'); });
    stop = startInboundDispatcher(context, { pollIntervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.listPendingWork()).toEqual([]);
  });

  it('reconciles a stale document revision once, then stops when processed', async () => {
    const app = db.recordInbound(message('lost', true), 30).application;
    db.markWorkDispatched(db.listPendingWork()[0].id);
    stop = startInboundDispatcher(context);
    await vi.advanceTimersByTimeAsync(60000);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledWith('cv-processing', { applicationId: app.id },
      { jobId: `reconcile-${app.id}-1` });
    db.updateApplication(app.id, { processed_revision: 1 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
  });

  it('recovers every page when processed rows leave the selection during publication', async () => {
    const ids = db.getDb().transaction(() => Array.from({ length: 1005 }, () => db.createApplication({
      whatsapp_jid: '94771234567@s.whatsapp.net', whatsapp_number: '+94771234567',
      media_id: 'media', revision: 1, processed_revision: 0,
    }).id))();
    const published: string[] = [];
    vi.mocked(enqueueJob).mockImplementation(async (_name, data) => {
      const { applicationId } = data as { applicationId: string };
      published.push(applicationId);
      db.updateApplication(applicationId, { processed_revision: 1 });
      return {} as never;
    });
    const selection = vi.spyOn(db, 'listRecoveryApplications');
    stop = startInboundDispatcher(context);
    await vi.advanceTimersByTimeAsync(60000);
    expect(published).toEqual(ids);
    expect(selection).toHaveBeenCalledTimes(2);
    expect(db.listRecoveryApplications()).toEqual([]);
    await stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not duplicate a waiting recovery job, but republishes after Redis loss', async () => {
    const app = db.recordInbound(message('redis-loss', true), 30).application;
    db.markWorkDispatched(db.listPendingWork()[0].id);
    stop = startInboundDispatcher(context);
    await vi.advanceTimersByTimeAsync(60000);
    getJob.mockResolvedValue({ getState: vi.fn().mockResolvedValue('waiting') });
    await vi.advanceTimersByTimeAsync(60000);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    getJob.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(60000);
    expect(enqueueJob).toHaveBeenCalledTimes(2);
    expect(enqueueJob).toHaveBeenLastCalledWith('cv-processing', { applicationId: app.id },
      { jobId: `reconcile-${app.id}-1` });
  });

  it.each(['completed', 'failed'])('retries retained %s recovery jobs instead of suppressing work', async state => {
    db.recordInbound(message('retained', true), 30);
    db.markWorkDispatched(db.listPendingWork()[0].id);
    const retry = vi.fn().mockResolvedValue(undefined);
    getJob.mockResolvedValue({ getState: vi.fn().mockResolvedValue(state), retry });
    stop = startInboundDispatcher(context);
    await vi.advanceTimersByTimeAsync(60000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith(state);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
