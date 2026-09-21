import type { Job, Queue } from 'bullmq';
import type Database from 'better-sqlite3';
import { QUEUES, type AppConfig, type QueueName } from '../src/contracts.js';

export interface WorkerContext {
  config: AppConfig;
  db: Database.Database;
  queues: Record<QueueName, Queue>;
}
export type QueueProcessor = (job: Job, token?: string) => Promise<unknown>;
export type ProcessorRegistry = Record<QueueName, QueueProcessor>;
export type ProcessorFactory = (context: WorkerContext) => Partial<ProcessorRegistry> | Promise<Partial<ProcessorRegistry>>;

/** Side-effect free: importing this module does not open DB or Redis connections. */
export function createProcessorRegistry(overrides: Partial<ProcessorRegistry> = {}): ProcessorRegistry {
  return Object.fromEntries(QUEUES.map(name => [name, async (job: Job, token?: string) => {
    if (job.name === 'noop') return;
    const processor = overrides[name];
    if (processor) return processor(job, token);
    throw new Error('not implemented');
  }])) as ProcessorRegistry;
}
