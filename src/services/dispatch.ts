import type { AppConfig, InboundMessage } from '../contracts.js';
import * as db from '../database/db.js';
import { enqueueJob, getQueues } from '../queue/queues.js';
import { logger } from '../logger.js';

/** Structurally compatible with WorkerContext; composition owns DB/queue lifetime. */
export interface DispatcherContext {
  config: Pick<AppConfig, 'redisUrl' | 'sessionTimeoutMinutes'>;
}
export interface InboundJobData {
  applicationId: string;
  workId?: string;
  /** Informational snapshot; consumers must reload authoritative DB state. */
  revision?: number;
}
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_RECOVERY_INTERVAL_MS = 60_000;
export interface DispatcherOptions {
  pollIntervalMs?: number;
  recoveryIntervalMs?: number;
}

/** At-least-once publication, deduplicated by BullMQ job ID while retained. */
async function publishInboundWork(work: db.PendingWork): Promise<void> {
  await enqueueJob<InboundJobData>('cv-processing', {
    applicationId: work.application_id, workId: String(work.id), revision: work.revision,
  }, { jobId: `inbound-${work.id}` });
  // Never claim/ack before publication: even a crash must leave recoverable work.
  db.markWorkDispatched(work.id);
}

/** Persist receipt before Redis I/O. No greeting/network side effects beyond enqueue. */
export async function ingestInboundMessage(
  context: DispatcherContext,
  msg: InboundMessage,
): Promise<db.InboundResult> {
  const result = db.recordInbound(msg, context.config.sessionTimeoutMinutes);
  const work = db.getPendingWorkByMessageId(msg.wa_message_id);
  if (result.duplicate) {
    // Repeat only an already-durable ack. An unacked duplicate may have an
    // in-flight/failed original enqueue; leave it for the outbox, never discard it.
    if (work?.dispatched_at != null) db.markWorkDispatched(work.id);
    return result;
  }
  if (work && work.dispatched_at === null) {
    getQueues(context.config.redisUrl);
    await publishInboundWork(work);
  }
  return result;
}

/** Shared startup/periodic recovery; SQLite checkpoints decide the stage on replay. */
export async function reconcileApplications(
  context: DispatcherContext,
  options: { stopped?: () => boolean; failFast?: boolean } = {},
): Promise<number> {
  const queues = getQueues(context.config.redisUrl);
  let count = 0;
  let afterId = '';
  for (;;) {
    if (options.stopped?.()) return count;
    const apps = db.listRecoveryApplications(1000, afterId);
    for (const app of apps) {
      if (options.stopped?.()) return count;
      try {
        const jobId = `reconcile-${app.id}-${app.revision}`;
        const existing = await queues['cv-processing'].getJob(jobId);
        if (existing) {
          const state = await existing.getState();
          if (state !== 'completed' && state !== 'failed') continue;
          await existing.retry(state);
        } else {
          await enqueueJob<InboundJobData>('cv-processing', { applicationId: app.id }, { jobId });
        }
        count++;
      } catch {
        logger.error({ applicationId: app.id }, 'Inbound recovery publication failed');
        if (options.failFast) throw new Error('Startup recovery publication failed');
      }
    }
    if (apps.length < 1000) return count;
    afterId = apps[apps.length - 1].id;
  }
}

function interval(value: number): number {
  if (!Number.isFinite(value) || value < 1) throw new Error('Invalid dispatcher interval');
  return value;
}

/**
 * Explicit composition only: no import-time connections, timers or signals.
 * stop() cancels future passes and waits for both in-flight loops; call before
 * closing SQLite/queues. Polls do not overlap with their own previous pass.
 */
export function startInboundDispatcher(
  context: DispatcherContext,
  options: DispatcherOptions = {},
): () => Promise<void> {
  const pollMs = interval(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const recoveryMs = interval(options.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS);
  getQueues(context.config.redisUrl);
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const running = new Set<Promise<void>>();

  async function drain(): Promise<void> {
    for (const work of db.listPendingWork()) {
      if (stopped) break;
      try { await publishInboundWork(work); }
      catch {
        // Raw errors can contain Redis credentials or candidate content.
        logger.error({ workId: work.id }, 'Inbound outbox publication failed; work remains pending');
      }
    }
  }

  async function reconcile(): Promise<void> {
    await reconcileApplications(context, { stopped: () => stopped });
  }

  function schedule(task: () => Promise<void>, delay: number, repeat: number, label: string): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped) return;
      const execution = Promise.resolve().then(task).catch(() => {
        logger.error({ operation: label }, 'Inbound dispatcher pass failed');
      }).finally(() => {
        running.delete(execution);
        if (!stopped) schedule(task, repeat, repeat, label);
      });
      running.add(execution);
    }, delay);
    timers.add(timer);
  }

  schedule(drain, 0, pollMs, 'outbox');
  schedule(reconcile, recoveryMs, recoveryMs, 'reconciliation');
  let stopping: Promise<void> | undefined;
  return function stop(): Promise<void> {
    if (!stopping) {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      stopping = Promise.all([...running]).then(() => undefined);
    }
    return stopping;
  };
}
