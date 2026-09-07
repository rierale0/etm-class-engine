import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AnalyzeRequest } from '../../shared/src/index.js';
import { ActiveVideoJobError, IdempotencyConflictError } from './index.js';

export interface BatchJobInput {
  videoId: string;
  payload: AnalyzeRequest;
}

export interface CreateBatchInput {
  name: string;
  idempotencyKey: string;
  payloadHash: string;
  jobs: BatchJobInput[];
}

export const batchWithJobs = {
  jobs: { orderBy: { batchOrder: Prisma.SortOrder.asc } },
} satisfies Prisma.BatchInclude;

export type BatchWithJobs = Prisma.BatchGetPayload<{ include: typeof batchWithJobs }>;

export async function createBatchIdempotently(
  database: PrismaClient,
  input: CreateBatchInput,
): Promise<{ batch: BatchWithJobs; created: boolean }> {
  return database.$transaction(
    async (transaction) => {
      const byKey = await transaction.batch.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: batchWithJobs,
      });
      if (byKey) {
        if (byKey.payloadHash !== input.payloadHash) throw new IdempotencyConflictError();
        return { batch: byKey, created: false };
      }

      const active = await transaction.job.findFirst({
        where: {
          videoId: { in: input.jobs.map((job) => job.videoId) },
          status: { notIn: ['completed', 'failed'] },
        },
      });
      if (active) throw new ActiveVideoJobError(active.id);

      const batchId = randomUUID();
      try {
        const batch = await transaction.batch.create({
          data: {
            id: batchId,
            name: input.name,
            idempotencyKey: input.idempotencyKey,
            payloadHash: input.payloadHash,
            jobs: {
              create: input.jobs.map((job, index) => ({
                id: randomUUID(),
                videoId: job.videoId,
                status: 'queued',
                progress: 0,
                requestPayload: job.payload,
                idempotencyKey: `batch-${batchId}-${String(index)}`,
                payloadHash: input.payloadHash,
                callbackStatus: 'awaiting_batch',
                batchOrder: index,
              })),
            },
          },
          include: batchWithJobs,
        });
        return { batch, created: true };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const racedKey = await transaction.batch.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
            include: batchWithJobs,
          });
          if (racedKey) {
            if (racedKey.payloadHash !== input.payloadHash) throw new IdempotencyConflictError();
            return { batch: racedKey, created: false };
          }
          const racedVideo = await transaction.job.findFirst({
            where: {
              videoId: { in: input.jobs.map((job) => job.videoId) },
              status: { notIn: ['completed', 'failed'] },
            },
          });
          if (racedVideo) throw new ActiveVideoJobError(racedVideo.id);
        }
        throw error;
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export function listBatches(database: PrismaClient, limit = 50): Promise<BatchWithJobs[]> {
  return database.batch.findMany({
    include: batchWithJobs,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export function getBatch(database: PrismaClient, id: string): Promise<BatchWithJobs | null> {
  return database.batch.findUnique({ where: { id }, include: batchWithJobs });
}
