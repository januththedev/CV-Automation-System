import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Worker, type Job } from 'bullmq';
import { QUEUES } from '../../contracts.js';
import { closeQueues, enqueueJob, getQueues, getQueueEvents, redisConnectionOptions, workerBackoffStrategy } from '../queues.js';

// Point REDIS_URL at a dedicated test Redis database, not a production queue.
describe.skipIf(!process.env.REDIS_URL)('real Redis queue roundtrip', () => {
  afterAll(() => closeQueues());
  it('roundtrips a job, deduplicates IDs, and exposes default retry/retention options', async () => {
    const redisUrl = process.env.REDIS_URL!;
    const queues = getQueues(redisUrl);
    expect(Object.keys(queues)).toEqual([...QUEUES]);
    expect(getQueues(redisUrl)).toBe(queues);
    const events = getQueueEvents('cv-processing');
    await events.waitUntilReady();
    const worker = new Worker('cv-processing', async (job: Job) => job.data, {
      connection: redisConnectionOptions(redisUrl, true),
      settings: { backoffStrategy: workerBackoffStrategy },
    });
    const id = `queue-test-${randomUUID()}`;
    try {
      await worker.waitUntilReady();
      const job = await enqueueJob('cv-processing', { test: id }, { jobId: id, jobName: 'noop' });
      expect(job.opts).toMatchObject({ attempts: 5, backoff: { type: 'capped-exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: false });
      expect(await job.waitUntilFinished(events, 10000)).toEqual({ test: id });
      expect((await enqueueJob('cv-processing', { test: id }, { jobId: id })).id).toBe(job.id);
    } finally {
      await worker.close();
      await (await queues['cv-processing'].getJob(id))?.remove();
    }
  });
});
