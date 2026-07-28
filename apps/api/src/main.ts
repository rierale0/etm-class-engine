import { Queue } from 'bullmq';
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
const queue = new Queue<{ jobId: string }>(queueName, { connection });

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
