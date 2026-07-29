import { type PrismaClient, type Prisma } from '@prisma/client';
import type { ClassAnalysis, JobStatus, ProcessingWarning } from '../../shared/src/index.js';
import type { JobStore, PipelineJob } from '../../analysis/src/pipeline.js';
import type { PipelineError } from '../../analysis/src/errors.js';

export class PrismaJobStore implements JobStore {
  constructor(private readonly database: PrismaClient) {}

  async get(id: string): Promise<PipelineJob | null> {
    const job = await this.database.job.findUnique({ where: { id } });
    if (!job) return null;
    return {
      id: job.id,
      videoId: job.videoId,
      batchId: job.batchId,
      requestPayload: job.requestPayload,
    };
  }

  async stage(id: string, status: JobStatus, progress: number, attempt: number): Promise<void> {
    await this.database.job.update({
      where: { id },
      data: {
        status,
        progress,
        attemptCount: attempt,
        ...(status === 'validating_video' ? { startedAt: new Date() } : {}),
      },
    });
  }

  async saveResult(
    id: string,
    analysis: ClassAnalysis,
    characterCount: number,
    warnings: ProcessingWarning[],
  ): Promise<void> {
    await this.database.job.update({
      where: { id },
      data: {
        resultJson: analysis,
        resultCharacterCount: characterCount,
        warnings: warnings as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async complete(id: string, callbackAttempts: number): Promise<void> {
    await this.database.job.update({
      where: { id },
      data: {
        status: 'completed',
        progress: 100,
        callbackStatus: callbackAttempts === 0 ? 'disabled' : 'sent',
        callbackAttempts,
        completedAt: new Date(),
      },
    });
  }

  async fail(id: string, error: PipelineError): Promise<void> {
    await this.database.job.update({
      where: { id },
      data: {
        status: 'failed',
        errorCode: error.code,
        errorMessage: error.message,
        completedAt: new Date(),
      },
    });
  }

  async retry(id: string, error: PipelineError): Promise<void> {
    await this.database.job.update({
      where: { id },
      data: {
        status: 'queued',
        errorCode: error.code,
        errorMessage: error.message,
      },
    });
  }

  async callbackFailed(id: string, error: PipelineError): Promise<void> {
    await this.database.job.update({
      where: { id },
      data: {
        callbackStatus: 'failed',
        callbackLastError: error.message,
      },
    });
  }

  async callbackSent(id: string, attempts: number): Promise<void> {
    await this.database.job.update({
      where: { id },
      data: {
        callbackStatus: attempts === 0 ? 'disabled' : 'sent',
        callbackAttempts: attempts,
      },
    });
  }

  async isCancelled(id: string): Promise<boolean> {
    const job = await this.database.job.findUnique({
      where: { id },
      select: { cancelRequestedAt: true },
    });
    return job?.cancelRequestedAt !== null && job?.cancelRequestedAt !== undefined;
  }
}
