import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../../packages/config/src/index.js';
import { createDatabase, createJobIdempotently } from '../../../packages/database/src/index.js';
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
  jobId: string;
}

const queue = new Queue<QueuePayload>(queueName, { connection });

const dependencies: ApiDependencies = {
  createJob: (input) => createJobIdempotently(database, input),
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
  getJob: (jobId) => database.job.findUnique({ where: { id: jobId } }),
  listJobs: (limit) =>
    database.job.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        videoId: true,
        status: true,
        progress: true,
        requestPayload: true,
        warnings: true,
        errorCode: true,
        errorMessage: true,
        callbackStatus: true,
        callbackAttempts: true,
        callbackLastError: true,
        resultCharacterCount: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        updatedAt: true,
      },
    }),
  async enqueueCallbackRetry(jobId) {
    await database.job.update({
      where: { id: jobId },
      data: { callbackStatus: 'pending', callbackLastError: null },
    });
    try {
      await queue.add(
        'retry-callback',
        { jobId },
        {
          jobId: `callback-${jobId}-${randomUUID()}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1_000 },
          removeOnFail: { age: 30 * 24 * 60 * 60, count: 5_000 },
        },
      );
    } catch (error) {
      await database.job.update({
        where: { id: jobId },
        data: {
          callbackStatus: 'failed',
          callbackLastError: 'Callback retry could not be queued',
        },
      });
      throw error;
    }
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
