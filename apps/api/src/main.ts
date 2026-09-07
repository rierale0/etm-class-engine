import { Queue } from 'bullmq';
import { loadConfig } from '../../../packages/config/src/index.js';
import { createDatabase, createJobIdempotently } from '../../../packages/database/src/index.js';
import {
  createBatchIdempotently,
  getBatch,
  listBatches,
  type BatchWithJobs,
} from '../../../packages/database/src/batches.js';
import { queueName } from '../../../packages/shared/src/index.js';
import { CallbackSender } from '../../../packages/analysis/src/callback.js';
import { buildApp, type ApiDependencies } from './app.js';
import { buildBatchDeliveryPayload } from './batch-delivery.js';
import { UiConflictError, UiDeliveryError, UiNotFoundError, type UiDependencies } from './ui.js';

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
const batchCallback = new CallbackSender(
  config.N8N_CALLBACK_URL,
  config.N8N_CALLBACK_SECRET,
  config.CALLBACK_MAX_ATTEMPTS,
);

async function enqueueJob(jobId: string): Promise<void> {
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
}

const dependencies: ApiDependencies = {
  createJob: (input) => createJobIdempotently(database, input),
  enqueue: enqueueJob,
  getJob: (jobId) => database.job.findUnique({ where: { id: jobId } }),
  async ready() {
    await Promise.all([database.$queryRaw`SELECT 1`, queue.waitUntilReady()]);
  },
  async close() {
    await Promise.all([database.$disconnect(), queue.close()]);
  },
};

const uiDependencies: UiDependencies = {
  createBatch: (input) => createBatchIdempotently(database, input),
  listBatches: () => listBatches(database),
  getBatch: (batchId) => getBatch(database, batchId),
  enqueue: enqueueJob,
  async retryJob(jobId) {
    const job = await database.job.findUnique({ where: { id: jobId } });
    if (!job || !job.batchId) throw new UiNotFoundError('No se encontró el trabajo del lote');
    if (job.status !== 'failed')
      throw new UiConflictError('Solo se pueden reintentar análisis fallidos');
    const queued = await queue.getJob(jobId);
    if (queued) await queued.remove();
    await database.$transaction([
      database.job.update({
        where: { id: jobId },
        data: {
          status: 'queued',
          progress: 0,
          errorCode: null,
          errorMessage: null,
          attemptCount: 0,
          callbackStatus: 'awaiting_batch',
          callbackAttempts: 0,
          callbackLastError: null,
          cancelRequestedAt: null,
          startedAt: null,
          completedAt: null,
        },
      }),
      database.batch.update({
        where: { id: job.batchId },
        data: {
          deliveryStatus: 'not_sent',
          deliveryAttempts: 0,
          deliveryLastError: null,
          deliveredAt: null,
        },
      }),
    ]);
    await enqueueJob(jobId);
  },
  async deliverBatch(batchId): Promise<BatchWithJobs> {
    const batch = await getBatch(database, batchId);
    if (!batch) throw new UiNotFoundError('No se encontró el lote');
    if (batch.deliveryStatus === 'accepted') return batch;
    if (!config.N8N_CALLBACK_URL || !config.N8N_CALLBACK_SECRET) {
      throw new UiConflictError('La entrega a n8n no está configurada');
    }
    if (batch.jobs.some((job) => job.status !== 'completed')) {
      throw new UiConflictError('Todos los vídeos deben completarse antes de enviar el lote a n8n');
    }
    await database.batch.update({
      where: { id: batchId },
      data: { deliveryStatus: 'sending', deliveryLastError: null },
    });
    try {
      const result = await batchCallback.send(
        buildBatchDeliveryPayload(batch),
        `batch-${batch.id}-educational-page-v1`,
      );
      await database.$transaction([
        database.batch.update({
          where: { id: batchId },
          data: {
            deliveryStatus: 'accepted',
            deliveryAttempts: result.attempts,
            deliveryLastError: null,
            deliveredAt: new Date(),
          },
        }),
        database.job.updateMany({
          where: { batchId },
          data: { callbackStatus: 'accepted', callbackAttempts: result.attempts },
        }),
      ]);
      const delivered = await getBatch(database, batchId);
      if (!delivered) throw new UiNotFoundError('No se encontró el lote entregado');
      return delivered;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'n8n rechazó la entrega';
      await database.batch.update({
        where: { id: batchId },
        data: { deliveryStatus: 'failed', deliveryLastError: message },
      });
      throw new UiDeliveryError('n8n no pudo aceptar el lote');
    }
  },
};

const app = await buildApp(config, dependencies, undefined, uiDependencies);

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
