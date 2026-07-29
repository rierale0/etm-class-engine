import { Prisma, PrismaClient, type AnalysisBatch, type Job } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { AnalyzeRequest, JobStatus } from '../../shared/src/index.js';

export type DatabaseClient = PrismaClient;

export function createDatabase(databaseUrl?: string): PrismaClient {
  return new PrismaClient(
    databaseUrl
      ? {
          datasources: { db: { url: databaseUrl } },
        }
      : undefined,
  );
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('The idempotency key was already used with a different request');
    this.name = 'IdempotencyConflictError';
  }
}

export class ActiveVideoJobError extends Error {
  constructor(public readonly jobId: string) {
    super('An active job already exists for this video');
    this.name = 'ActiveVideoJobError';
  }
}

export interface CreateJobInput {
  videoId: string;
  payload: AnalyzeRequest;
  idempotencyKey: string;
  payloadHash: string;
}

export interface CreatedJob {
  job: Job;
  created: boolean;
}

export interface CreateAnalysisBatchItem {
  videoId: string;
  payload: AnalyzeRequest;
}

export interface CreateAnalysisBatchInput {
  name: string;
  items: CreateAnalysisBatchItem[];
}

export interface CreatedAnalysisBatch {
  batch: AnalysisBatch & { jobs: Job[] };
}

export async function createAnalysisBatch(
  database: PrismaClient,
  input: CreateAnalysisBatchInput,
): Promise<CreatedAnalysisBatch> {
  return database.$transaction(
    async (transaction) => {
      const videoIds = input.items.map((item) => item.videoId);
      const active = await transaction.job.findFirst({
        where: {
          videoId: { in: videoIds },
          status: { notIn: ['completed', 'failed'] },
        },
      });
      if (active) throw new ActiveVideoJobError(active.id);

      const batchId = randomUUID();
      const batch = await transaction.analysisBatch.create({
        data: {
          id: batchId,
          name: input.name,
          jobs: {
            create: input.items.map((item, position) => ({
              id: randomUUID(),
              videoId: item.videoId,
              status: 'queued',
              progress: 0,
              requestPayload: item.payload,
              idempotencyKey: `batch-${batchId}-${String(position)}-${item.videoId}`,
              payloadHash: createHash('sha256').update(JSON.stringify(item.payload)).digest('hex'),
              callbackStatus: 'disabled',
              batchPosition: position,
            })),
          },
        },
        include: { jobs: { orderBy: { batchPosition: 'asc' } } },
      });
      return { batch };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function createJobIdempotently(
  database: PrismaClient,
  input: CreateJobInput,
): Promise<CreatedJob> {
  return database.$transaction(
    async (transaction) => {
      const byKey = await transaction.job.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (byKey) {
        if (byKey.payloadHash !== input.payloadHash) throw new IdempotencyConflictError();
        return { job: byKey, created: false };
      }

      const active = await transaction.job.findFirst({
        where: {
          videoId: input.videoId,
          status: { notIn: ['completed', 'failed'] },
        },
      });
      if (active) throw new ActiveVideoJobError(active.id);

      try {
        const job = await transaction.job.create({
          data: {
            id: randomUUID(),
            videoId: input.videoId,
            status: 'queued',
            progress: 0,
            requestPayload: input.payload,
            idempotencyKey: input.idempotencyKey,
            payloadHash: input.payloadHash,
          },
        });
        return { job, created: true };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const racedKey = await transaction.job.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          });
          if (racedKey) {
            if (racedKey.payloadHash !== input.payloadHash) throw new IdempotencyConflictError();
            return { job: racedKey, created: false };
          }
          const racedVideo = await transaction.job.findFirst({
            where: {
              videoId: input.videoId,
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

export async function updateJobStage(
  database: PrismaClient,
  id: string,
  status: JobStatus,
  progress: number,
): Promise<void> {
  await database.job.update({
    where: { id },
    data: {
      status,
      progress,
      ...(status === 'validating_video' ? { startedAt: new Date() } : {}),
    },
  });
}
