import { describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { QUEUES } from '../../contracts.js';
import { createProcessorRegistry, recoveryQueue, recoverApplications } from '../../../worker/worker-context.js';
import { cappedExponentialBackoff, QUEUE_CONCURRENCY, redisConnectionOptions } from '../queues.js';

describe('runtime registry', () => {
  it('provides every queue, fails loudly for unwired work, and accepts explicit noop', async () => {
    const registry = createProcessorRegistry();
    expect(Object.keys(registry)).toEqual([...QUEUES]);
    for (const queue of QUEUES) {
      await expect(registry[queue]({ name: queue } as Job)).rejects.toThrow('not implemented');
      await expect(registry[queue]({ name: 'noop' } as Job)).resolves.toBeUndefined();
    }
  });
  it('injects processors without replacing unrelated defaults', async () => {
    const registry = createProcessorRegistry({ onedrive: async () => 'uploaded' });
    await expect(registry.onedrive({ name: 'upload' } as Job)).resolves.toBe('uploaded');
    await expect(registry['cv-processing']({ name: 'process' } as Job)).rejects.toThrow('not implemented');
  });
  it('routes recovery at the current stage and excludes idle and terminal states', () => {
    expect(recoveryQueue('RETRY_PENDING')).toBe('cv-processing');
    expect(recoveryQueue('AI_PROCESSING')).toBe('cv-processing');
    expect(recoveryQueue('UPLOADING_TO_ONEDRIVE')).toBe('onedrive');
    expect(recoveryQueue('CREATING_LINK')).toBe('onedrive');
    expect(recoveryQueue('WRITING_TO_GOOGLE_SHEETS')).toBe('google-sheets');
    for (const status of ['WAITING_FOR_DETAILS', 'COMPLETED', 'FAILED', 'NEEDS_REVIEW'] as const) {
      expect(recoveryQueue(status)).toBeNull();
    }
  });
  it('uses factor four backoff capped at five minutes and prescribed concurrency', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(cappedExponentialBackoff)).toEqual([1000, 4000, 16000, 64000, 256000, 300000, 300000]);
    expect(QUEUE_CONCURRENCY).toEqual({ 'cv-processing': 1, onedrive: 3, 'google-sheets': 3, 'whatsapp-confirm': 5 });
  });
  it('republishes recoverable applications per current status', async () => {
    const jobs: Array<{ queue: string; name: string; data: unknown; opts: Record<string, unknown> }> = [];
    const queue = (name: string) => ({ getJob: async () => undefined, add: async (jobName: string, data: unknown, opts: Record<string, unknown>) => { jobs.push({ queue: name, name: jobName, data, opts }); } });
    const queues = { 'cv-processing': queue('cv-processing'), onedrive: queue('onedrive'), 'google-sheets': queue('google-sheets') } as never;
    const count = await recoverApplications(
      [
        { id: 'APP-1', status: 'RETRY_PENDING', revision: 7 },
        { id: 'APP-2', status: 'WRITING_TO_GOOGLE_SHEETS', revision: 3 },
        { id: 'APP-3', status: 'CREATING_LINK', revision: 9 },
        { id: 'APP-4', status: 'WAITING_FOR_DETAILS', revision: 1 },
        { id: 'APP-5', status: 'COMPLETED', revision: 2 },
        { id: 'APP-6', status: 'FAILED', revision: 4 },
        { id: 'APP-7', status: 'NEEDS_REVIEW', revision: 5 },
      ] as never,
      queues,
    );
    expect(count).toBe(3);
    expect(jobs).toEqual([
      { queue: 'cv-processing', name: 'cv-processing', data: { applicationId: 'APP-1', resumeStatus: 'RETRY_PENDING', revision: 7 }, opts: { jobId: expect.stringMatching(/^recover-[a-f0-9]+$/) } },
      { queue: 'google-sheets', name: 'google-sheets', data: { applicationId: 'APP-2', resumeStatus: 'WRITING_TO_GOOGLE_SHEETS', revision: 3 }, opts: { jobId: expect.stringMatching(/^recover-[a-f0-9]+$/) } },
      { queue: 'onedrive', name: 'onedrive', data: { applicationId: 'APP-3', resumeStatus: 'CREATING_LINK', revision: 9 }, opts: { jobId: expect.stringMatching(/^recover-[a-f0-9]+$/) } },
    ]);
  });
  it('deduplicates live recovery jobs and retries retained terminal recovery jobs', async () => {
    const retries: string[] = [];
    let additions = 0;
    const queues = {
      'cv-processing': {
        getJob: async () => ({ getState: async () => 'active', retry: async () => { throw new Error('active job retried'); } }),
        add: async () => { additions++; },
      },
      onedrive: {
        getJob: async () => ({ getState: async () => 'failed', retry: async (state: string) => { retries.push(state); } }),
        add: async () => { additions++; },
      },
    } as never;
    expect(await recoverApplications([
      { id: 'A', status: 'AI_PROCESSING' },
      { id: 'B', status: 'CREATING_LINK' },
    ], queues)).toBe(1);
    expect(additions).toBe(0);
    expect(retries).toEqual(['failed']);
  });
  it('propagates publication failure rather than claiming successful recovery', async () => {
    const queues = { 'cv-processing': { getJob: async () => undefined, add: async () => { throw new Error('Redis unavailable'); } } } as never;
    await expect(recoverApplications([{ id: 'A', status: 'RETRY_PENDING' }], queues)).rejects.toThrow('Redis unavailable');
  });
  it('preserves redis TLS, credentials and database and rejects malformed URLs', () => {
    expect(redisConnectionOptions('rediss://user:p%40ss@localhost:6380/2')).toMatchObject({ host: 'localhost', port: 6380, username: 'user', password: 'p@ss', db: 2, tls: {} });
    expect(() => redisConnectionOptions('https://localhost')).toThrow();
    expect(() => redisConnectionOptions('redis://localhost/not-a-db')).toThrow();
  });
});
