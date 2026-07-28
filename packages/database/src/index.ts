import { Prisma, PrismaClient, type Job } from '@prisma/client';
import { randomUUID } from 'node:crypto';
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
