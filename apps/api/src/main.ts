import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { loadConfig } from '../../../packages/config/src/index.js';
import {
  createAnalysisBatch,
  createDatabase,
  createJobIdempotently,
} from '../../../packages/database/src/index.js';
import { queueName } from '../../../packages/shared/src/index.js';
import { buildApp, type ApiDependencies } from './app.js';

const config = loadConfig();
const database = createDatabase();
const redisUrl = new URL(config.REDIS_URL);
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {}),
  ...(redisUrl.username ? { username: decodeURIComponent(redisUrl.username) } : {}),
  ...(redisUrl.protocol === 'rediss:' ? { tls: {} } : {}),
};
interface QueuePayload {
  jobId?: string;
  batchId?: string;
}

const queue = new Queue<QueuePayload>(queueName, { connection });

const dependencies: ApiDependencies = {
  createJob: (input) => createJobIdempotently(database, input),
  createBatch: (input) => createAnalysisBatch(database, input),
  async enqueue(jobId) {
    await queue.add(
      'analyze-class',
      { jobId },
      {
        jobId,
        attempts: 4,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1_000 },
        removeOnFail: { age: 30 * 24 * 60 * 60, count: 5_000 },
      },
    );
  },
  async enqueueMany(jobIds) {
    await queue.addBulk(
      jobIds.map((jobId) => ({
        name: 'analyze-class',
        data: { jobId },
        opts: {
          jobId,
          attempts: 4,
          backoff: { type: 'exponential' as const, delay: 30_000 },
          removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1_000 },
          removeOnFail: { age: 30 * 24 * 60 * 60, count: 5_000 },
        },
      })),
    );
  },
  getJob: (jobId) => database.job.findUnique({ where: { id: jobId } }),
  getBatch: (batchId) =>
    database.analysisBatch.findUnique({
      where: { id: batchId },
      include: { jobs: { orderBy: { batchPosition: 'asc' } } },
    }),
  listBatches: (limit) =>
    database.analysisBatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        jobs: {
          orderBy: { batchPosition: 'asc' },
          select: {
            id: true,
            videoId: true,
            status: true,
            progress: true,
            requestPayload: true,
            resultCharacterCount: true,
            warnings: true,
            errorCode: true,
            errorMessage: true,
            callbackStatus: true,
            callbackAttempts: true,
            callbackLastError: true,
            batchId: true,
            batchPosition: true,
            createdAt: true,
            startedAt: true,
            completedAt: true,
            updatedAt: true,
          },
        },
      },
    }),
  async enqueueBatchSend(batchId) {
    const claimed = await database.analysisBatch.updateMany({
      where: { id: batchId, callbackStatus: { in: ['not_sent', 'failed'] } },
      data: { callbackStatus: 'pending', callbackLastError: null },
    });
    if (claimed.count !== 1) return false;
    try {
      await queue.add(
        'send-batch-callback',
        { batchId },
        {
          jobId: `batch-callback-${batchId}-${randomUUID()}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1_000 },
          removeOnFail: { age: 30 * 24 * 60 * 60, count: 5_000 },
        },
      );
    } catch (error) {
      await database.analysisBatch.updateMany({
        where: { id: batchId, callbackStatus: 'pending' },
        data: {
          callbackStatus: 'failed',
          callbackLastError: 'Batch callback could not be queued',
        },
      });
      throw error;
    }
    return true;
  },
  async enqueueBatchJobRetry(batchId, jobId) {
    const claimed = await database.job.updateMany({
      where: { id: jobId, batchId, status: 'failed' },
      data: {
        status: 'queued',
        progress: 0,
        errorCode: null,
        errorMessage: null,
        resultJson: Prisma.DbNull,
        resultCharacterCount: null,
        warnings: Prisma.DbNull,
        callbackStatus: 'disabled',
        callbackAttempts: 0,
        callbackLastError: null,
        completedAt: null,
        cancelRequestedAt: null,
      },
    });
    if (claimed.count !== 1) return false;
    try {
      await queue.add(
        'analyze-class',
        { jobId },
        {
          jobId: `analysis-retry-${jobId}-${randomUUID()}`,
          attempts: 4,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1_000 },
          removeOnFail: { age: 30 * 24 * 60 * 60, count: 5_000 },
        },
      );
    } catch (error) {
      await database.job.updateMany({
        where: { id: jobId, batchId, status: 'queued' },
        data: {
          status: 'failed',
          errorCode: 'QUEUE_FAILED',
          errorMessage: 'Class retry could not be queued',
          completedAt: new Date(),
        },
      });
      throw error;
    }
    return true;
  },
  async ready() {
    await Promise.all([database.$queryRaw`SELECT 1`, queue.waitUntilReady()]);
  },
  async close() {
    await Promise.all([database.$disconnect(), queue.close()]);
  },
};

const app = await buildApp(config, dependencies);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'API shutdown requested');
  await app.close();
  process.exitCode = 0;
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.fatal({ err: error }, 'API startup failed');
  process.exitCode = 1;
}
