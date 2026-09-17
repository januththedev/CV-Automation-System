import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import { QUEUES, type QueueName } from '../contracts.js';
import { logger } from '../logger.js';

export { QUEUES, type QueueName } from '../contracts.js';
export const QUEUE_CONCURRENCY: Readonly<Record<QueueName, number>> = Object.freeze({
  'cv-processing': 1,
  onedrive: 3,
  'google-sheets': 3,
  'whatsapp-confirm': 5,
});
export const BACKOFF_TYPE = 'capped-exponential';
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: BACKOFF_TYPE, delay: 1000 },
  removeOnComplete: 1000,
  removeOnFail: false,
};

/** BullMQ's built-in exponential uses factor 2 and has no cap. */
export function cappedExponentialBackoff(attemptsMade: number): number {
  return Math.min(300000, 1000 * 4 ** Math.max(0, attemptsMade - 1));
}
export function workerBackoffStrategy(attemptsMade: number, type?: string): number {
  if (type !== BACKOFF_TYPE) throw new Error(`Unknown backoff type: ${type}`);
  return cappedExponentialBackoff(attemptsMade);
}

/** Producers fail promptly; workers/blocking QueueEvents retry connections indefinitely. */
export function redisConnectionOptions(redisUrl: string, blocking = false): RedisOptions {
  const url = new URL(redisUrl);
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('Expected a redis:// or rediss:// URL');
  const database = url.pathname.replace(/^\//, '');
  if (database && !/^\d+$/.test(database)) throw new Error('Invalid Redis database number');
  const db = database ? Number(database) : 0;
  if (!Number.isSafeInteger(db)) throw new Error('Invalid Redis database number');
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: blocking ? null : 1,
    connectTimeout: 10000,
  };
}

let queues: Record<QueueName, Queue> | undefined;
let activeUrl: string | undefined;
let closing: Promise<void> | undefined;
const events = new Map<QueueName, QueueEvents>();

export function getQueues(redisUrl: string): Record<QueueName, Queue> {
  if (closing) throw new Error('Queues are closing');
  if (queues) {
    if (activeUrl !== redisUrl) throw new Error('Queues already initialized for a different Redis URL; closeQueues first');
    return queues;
  }
  const connection = redisConnectionOptions(redisUrl);
  queues = Object.fromEntries(QUEUES.map(name => {
    const queue = new Queue(name, { connection, defaultJobOptions: { ...DEFAULT_JOB_OPTIONS } });
    // Do not log candidate data, job payloads, or Redis credentials.
    queue.on('error', () => logger.error({ queue: name }, 'Queue connection error'));
    return [name, queue];
  })) as Record<QueueName, Queue>;
  activeUrl = redisUrl;
  return queues;
}

export type EnqueueOptions = JobsOptions & { jobName?: string };
export async function enqueueJob<T = unknown>(name: QueueName, data: T, opts: EnqueueOptions = {}) {
  if (!queues || closing) throw new Error('Call getQueues(redisUrl) before enqueueJob');
  const { jobName = name, ...jobOptions } = opts;
  return queues[name].add(jobName, data, jobOptions);
}

export function getQueueEvents(name: QueueName): QueueEvents {
  if (!activeUrl || closing) throw new Error('Call getQueues(redisUrl) before getQueueEvents');
  let result = events.get(name);
  if (!result) {
    result = new QueueEvents(name, { connection: redisConnectionOptions(activeUrl, true) });
    result.on('error', () => logger.error({ queue: name }, 'Queue events connection error'));
    events.set(name, result);
  }
  return result;
}

/** Call after workers finish, so active processors can still publish follow-up jobs. */
export function closeQueues(): Promise<void> {
  if (closing) return closing;
  const resources = [...events.values(), ...Object.values(queues ?? {})];
  closing = (async () => {
    try {
      const results = await Promise.allSettled(resources.map(resource => resource.close()));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Queue shutdown failed');
    } finally {
      events.clear();
      queues = undefined;
      activeUrl = undefined;
      closing = undefined;
    }
  })();
  return closing;
}
