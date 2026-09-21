import type { Job } from 'bullmq';
import * as db from '../../src/database/db.js';
import { WhatsAppClient } from '../../src/integrations/whatsapp/client.js';
import { OneDriveClient } from '../../src/integrations/onedrive/client.js';
import { SheetsClient } from '../../src/integrations/google-sheets/client.js';
import { completed } from '../../src/integrations/whatsapp/templates.js';
import { sendAdmin } from '../../src/services/notify.js';
import { DEFAULT_JOB_OPTIONS } from '../../src/queue/queues.js';
import type { ProcessorRegistry, WorkerContext } from '../worker-context.js';
import { processCv } from './cv-processing.js';
import { processOneDrive } from './onedrive.js';
import { processSheets } from './sheets.js';
import { digest, finish, openPass, StaleRevision, type OutboundData, type Pass, type PipelineServices, type Stage } from './types.js';
export type { PipelineJobData, OutboundData } from './types.js';

/** Explicitly inject this factory into startWorkerRuntime; no import-time I/O. */
export function createPipelineProcessors(context: WorkerContext): ProcessorRegistry {
  let whatsapp: WhatsAppClient | undefined;
  let onedrive: OneDriveClient | undefined;
  let sheets: SheetsClient | undefined;
  let headers: Promise<void> | undefined;
  const locks = new Map<string, Promise<unknown>>();
  const services: PipelineServices = {
    context,
    whatsapp() {
      if (!context.config.whatsapp) throw new Error('WhatsApp is not configured');
      return whatsapp ??= new WhatsAppClient(context.config.whatsapp);
    },
    onedrive() {
      if (!context.config.onedrive) throw new Error('OneDrive is not configured');
      return onedrive ??= new OneDriveClient(context.config.onedrive);
    },
    sheets() {
      if (!context.config.sheets) throw new Error('Sheets is not configured');
      return sheets ??= new SheetsClient(context.config.sheets);
    },
    ensureHeaders() {
      return headers ??= services.sheets().ensureHeaderRow().catch(error => { headers = undefined; throw error; });
    },
    async notify(event) {
      if (!context.config.whatsapp || !context.config.adminWhatsappNumber) return;
      await sendAdmin(event, context.config.whatsapp, context.config.adminWhatsappNumber);
    },
    async serialize(key, action) {
      const previous = locks.get(key) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(action);
      locks.set(key, current);
      try { return await current; }
      finally { if (locks.get(key) === current) locks.delete(key); }
    },
    async enqueue(name, data, key) {
      const queue = context.queues[name];
      const jobId = `pipeline-${digest(key)}`;
      const existing = await queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        // Recovery must not be suppressed by a retained terminal job.
        if (state === 'completed' || state === 'failed') await existing.retry(state);
        return;
      }
      await queue.add(name, data, { ...DEFAULT_JOB_OPTIONS, jobId });
    },
    async outbound(pass, purpose, body) {
      pass.refresh();
      if (pass.journal.sent?.includes(purpose)) return;
      await services.enqueue('whatsapp-confirm', { to: pass.app.whatsapp_number, body,
        applicationId: pass.app.id, revision: pass.revision, purpose,
      }, `outbound-${purpose}-${pass.app.id}-${pass.revision}`);
    },
  };

  async function failure(pass: Pass | undefined, job: Job, category: string): Promise<never> {
    // Never propagate a raw provider error (BullMQ persists failure messages/stacks).
    if (pass) {
      const exhausted = job.attemptsMade + 1 >= (job.opts.attempts ?? DEFAULT_JOB_OPTIONS.attempts ?? 1);
      try {
        pass.refresh();
        if (exhausted) {
          finish(pass, 'FAILED', { review: true, error: `${category}_FAILED` });
          try { await services.notify({ type: 'failed', appId: pass.app.id, error: 'processing' }); }
          catch {
            // Preserve a retryable admin delivery even after the document job exhausts.
            const { formatAdminMessage } = await import('../../src/services/notify.js');
            if (context.config.adminWhatsappNumber) {
              await services.enqueue('whatsapp-confirm', { to: context.config.adminWhatsappNumber,
                body: formatAdminMessage({ type: 'failed', appId: pass.app.id, error: 'processing' }),
              }, `admin-failure-${pass.app.id}-${pass.revision}`).catch(() => {});
            }
          }
        } else {
          // Outbound replay is selected by business status, even after Redis loss.
          pass.patch({ ...(category === 'WHATSAPP' ? {} : { status: 'RETRY_PENDING' as const }), error: `${category}_RETRY` });
        }
      } catch (error) { if (!(error instanceof StaleRevision)) throw new Error('Pipeline failure checkpoint unavailable'); }
    }
    throw new Error(`${category} operation failed`);
  }

  function wrap(stage: Stage, category: string): ProcessorRegistry['cv-processing'] {
    return async job => {
      if (job.name === 'noop') return;
      const id = job.data?.applicationId;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid application job');
      return services.serialize(`app-${id}`, async () => {
        let pass: Pass | undefined;
        try {
          const app = db.getApplicationById(id);
          if (!app) return;
          // Downstream jobs belong to their exact pass, never a replacement CV.
          if (category !== 'DOCUMENT' && job.data.revision !== undefined && job.data.revision !== app.revision) return;
          pass = await openPass(context, app);
          await stage(pass, services, job);
        } catch (error) {
          if (error instanceof StaleRevision) return; // durable inbound work owns the newer revision
          await failure(pass, job, category);
        }
      });
    };
  }

  async function deliver(job: Job): Promise<void> {
    if (job.name === 'noop') return;
    const data = job.data as OutboundData;
    if (typeof data?.to !== 'string' || typeof data.body !== 'string') throw new Error('Invalid outbound job');
    await services.serialize(`app-${data.applicationId ?? digest(data.to)}`, async () => {
      let pass: Pass | undefined;
      try {
        if (data.applicationId) {
          const app = db.getApplicationById(data.applicationId);
          if (!app || (data.purpose !== 'greeting' && data.revision !== undefined && app.revision !== data.revision)) return;
          pass = await openPass(context, app);
          if (data.purpose === 'confirmation' && app.confirmation_sent) return;
          if (pass.journal.sent?.includes(data.purpose!)) return;
          if (data.purpose === 'greeting') {
            const session = db.getSession(app.whatsapp_number);
            if (!session || session.application_id !== app.id || session.greeting_sent) return;
          }
          // Recipient identity is always reloaded from API metadata for candidate messages.
          data.to = app.whatsapp_number;
        }
        await services.whatsapp().sendText(data.to, data.purpose === 'confirmation' ? completed() : data.body);
        if (pass) {
          pass.refresh();
          if (data.purpose === 'greeting') db.markGreetingSent(pass.app.whatsapp_number, pass.app.id);
          if (data.purpose === 'confirmation') finish(pass, 'COMPLETED', { confirmation_sent: true, error: null, review: false });
          if (data.purpose === 'details') finish(pass, 'WAITING_FOR_DETAILS', { error: null });
          if (data.purpose) {
            pass.journal.sent = [...new Set([...(pass.journal.sent ?? []), data.purpose])];
            await pass.saveJournal();
          }
        }
      } catch (error) {
        if (error instanceof StaleRevision) return;
        await failure(pass, job, 'WHATSAPP');
      }
    });
  }
  return { 'cv-processing': wrap(processCv, 'DOCUMENT'), onedrive: wrap(processOneDrive, 'ONEDRIVE'),
    'google-sheets': wrap(processSheets, 'SHEETS'), 'whatsapp-confirm': deliver };
}
