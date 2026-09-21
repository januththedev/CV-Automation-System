import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, type Job } from 'bullmq';
import { logger } from '../src/logger.js';
import { loadConfig } from '../src/config.js';
import { reconcileApplications, startInboundDispatcher } from '../src/services/dispatch.js';
import { QUEUES } from '../src/contracts.js';
import { closeQueues, getQueues, QUEUE_CONCURRENCY, redisConnectionOptions, workerBackoffStrategy } from '../src/queue/queues.js';
import {
  createProcessorRegistry,
  type ProcessorFactory, type ProcessorRegistry, type WorkerContext,
} from './worker-context.js';

export interface WorkerRuntimeOptions {
  configDir?: string;
  config?: WorkerContext['config'];
  /** Optional replacement for the default pipeline factory. */
  processors?: ProcessorFactory | Partial<ProcessorRegistry>;
  registerSignals?: boolean;
}
export interface WorkerRuntime {
  context: WorkerContext;
  workers: Worker[];
  recovered: number;
  stop(): Promise<void>;
}

/** No connections, signal handlers, or processing are started by importing this file. */
export async function startWorkerRuntime(options: WorkerRuntimeOptions = {}): Promise<WorkerRuntime> {
  const config = options.config ?? loadConfig(options.configDir);
  const dbModule = await import('../src/database/db.js');
  // DB location is pinned to the configured data dir; no env override is honored here.
  const db = dbModule.getDb(path.join(config.dataDir, 'applications.db'));
  const workers: Worker[] = [];
  let stopping: Promise<void> | undefined;
  let stopDispatcher: (() => Promise<void>) | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      signalHandlers.clear();
      logger.info('Worker runtime stopping');
      const failures: unknown[] = [];
      if (stopDispatcher) {
        try { await stopDispatcher(); } catch (error) { failures.push(error); }
      }
      // Worker.close waits for active processors; their queues and DB remain usable.
      const results = await Promise.allSettled(workers.map(worker => worker.close()));
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      try { await closeQueues(); } catch (error) { failures.push(error); }
      try { dbModule.closeDb(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Worker shutdown failed');
    })();
    return stopping;
  };

  try {
    const queues = getQueues(config.redisUrl);
    const context: WorkerContext = { config, db, queues };
    const processors = options.processors ?? (await import('./pipeline/index.js')).createPipelineProcessors;
    const overrides = typeof processors === 'function'
      ? await processors(context) : processors;
    const registry = createProcessorRegistry(overrides);
    for (const name of QUEUES) {
      const worker = new Worker(name, registry[name], {
        connection: redisConnectionOptions(config.redisUrl, true),
        concurrency: QUEUE_CONCURRENCY[name],
        settings: { backoffStrategy: workerBackoffStrategy },
        autorun: false,
      });
      worker.on('failed', (job: Job | undefined) => logger.error({
        queue: name, jobId: job?.id, attemptsMade: job?.attemptsMade,
      }, 'Job failed'));
      worker.on('error', () => logger.error({ queue: name }, 'Worker connection error'));
      workers.push(worker);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(workers.map(worker => worker.waitUntilReady())),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Redis startup timeout')), 15000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }

    const recovered = await reconcileApplications(context, { failFast: true });

    // Durable outbox draining plus reconciliation of lost/unprocessed revisions.
    stopDispatcher = startInboundDispatcher(context);

    if (options.registerSignals !== false) {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        const handler = () => {
          void stop().catch(() => {
            logger.error('Worker shutdown failed');
            process.exitCode = 1;
          });
        };
        signalHandlers.set(signal, handler);
        process.on(signal, handler);
      }
    }
    for (const worker of workers) {
      void worker.run().catch(() => {
        logger.error({ queue: worker.name }, 'Worker run loop failed');
        process.exitCode = 1;
        void stop().catch(() => logger.error('Worker shutdown failed'));
      });
    }
    logger.info({ queues: QUEUES, recovered }, 'Worker runtime started');
    return { context, workers, recovered, stop };
  } catch (error) {
    await stop().catch(() => logger.error('Worker startup cleanup failed'));
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void startWorkerRuntime().catch(() => {
    logger.error('Worker boot failed');
    process.exitCode = 1;
  });
}
