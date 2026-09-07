import { describe, expect, it } from 'vitest';
import type { BatchWithJobs } from '../../../packages/database/src/batches.js';
import { validAnalysis } from '../../../tests/fixtures/analysis.js';
import { buildBatchDeliveryPayload } from './batch-delivery.js';

describe('batch delivery payload', () => {
  it('preserves pedagogical order and excludes transcripts before sending to n8n', () => {
    const batch = {
      id: '39f5a245-b69d-4b99-95e9-a0e43c5e9ef9',
      name: 'Conversation Club',
      createdAt: new Date('2026-08-22T10:00:00.000Z'),
      jobs: [
        {
          id: '9c5d60bb-714b-4fe8-a09a-60c4d4a546aa',
          videoId: 'DEMOclass02',
          batchOrder: 1,
          status: 'completed',
          requestPayload: {
            title: 'Part 2',
            classDate: '2026-08-22',
            teacher: 'Alex Morgan',
            course: 'ETM English',
            analyzeVisuals: false,
          },
          resultJson: validAnalysis('private transcript 2'),
        },
        {
          id: 'c82b703c-4824-4ba9-b82d-bc07a8eae36f',
          videoId: 'DEMOclass01',
          batchOrder: 0,
          status: 'completed',
          requestPayload: {
            title: 'Part 1',
            classDate: '2026-08-22',
            teacher: 'Alex Morgan',
            course: 'ETM English',
            analyzeVisuals: false,
          },
          resultJson: validAnalysis('private transcript 1'),
        },
      ],
    } as unknown as BatchWithJobs;

    const payload = buildBatchDeliveryPayload(batch) as {
      order: string[];
      classes: Record<string, { analysis: Record<string, unknown> }>;
    };

    expect(payload).not.toHaveProperty('data');
    expect(payload.order).toEqual(['DEMOclass01', 'DEMOclass02']);
    expect(payload.classes.DEMOclass01?.analysis).not.toHaveProperty('transcript');
    expect(payload.classes.DEMOclass02?.analysis).not.toHaveProperty('transcript');
  });
});
