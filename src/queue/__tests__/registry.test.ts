import { describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { QUEUES } from '../../contracts.js';
import { createProcessorRegistry } from '../../../worker/worker-context.js';
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
  it('uses factor four backoff capped at five minutes and prescribed concurrency', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(cappedExponentialBackoff)).toEqual([1000, 4000, 16000, 64000, 256000, 300000, 300000]);
    expect(QUEUE_CONCURRENCY).toEqual({ 'cv-processing': 1, onedrive: 3, 'google-sheets': 3, 'whatsapp-confirm': 5 });
  });
  it('preserves redis TLS, credentials and database and rejects malformed URLs', () => {
    expect(redisConnectionOptions('rediss://user:p%40ss@localhost:6380/2')).toMatchObject({ host: 'localhost', port: 6380, username: 'user', password: 'p@ss', db: 2, tls: {} });
    expect(() => redisConnectionOptions('https://localhost')).toThrow();
    expect(() => redisConnectionOptions('redis://localhost/not-a-db')).toThrow();
  });
});
