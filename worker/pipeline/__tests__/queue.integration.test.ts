import { describe, expect, it } from 'vitest';
import { QUEUES } from '../../../src/contracts.js';
import type { WorkerContext } from '../../worker-context.js';
import { createPipelineProcessors } from '../index.js';

describe('pipeline registry', () => {
  it('provides all canonical queues without constructing integrations', () => {
    const registry = createPipelineProcessors({ config: {}, queues: {}, db: {} } as WorkerContext);
    expect(Object.keys(registry).sort()).toEqual([...QUEUES].sort());
  });
});
