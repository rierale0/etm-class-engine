import type { BatchWithJobs } from '../../../packages/database/src/batches.js';
import { analyzeRequestSchema } from '../../../packages/shared/src/index.js';

export function buildBatchDeliveryPayload(batch: BatchWithJobs): unknown {
  const ordered = [...batch.jobs].sort(
    (left, right) => (left.batchOrder ?? 0) - (right.batchOrder ?? 0),
  );
  const classes: Record<string, unknown> = {};
  const order: string[] = [];
  for (const job of ordered) {
    if (job.status !== 'completed' || !job.resultJson) {
      throw new Error('Every class must be completed before delivering the batch');
    }
    const submission = analyzeRequestSchema.parse(job.requestPayload);
    const analysis = structuredClone(job.resultJson) as Record<string, unknown>;
    delete analysis.transcript;
    order.push(job.videoId);
    classes[job.videoId] = {
      submission: {
        jobId: job.id,
        videoId: job.videoId,
        ...submission,
      },
      analysis,
    };
  }
  return {
    batch: {
      id: batch.id,
      name: batch.name,
      createdAt: batch.createdAt.toISOString(),
      classCount: ordered.length,
    },
    order,
    classes,
  };
}
