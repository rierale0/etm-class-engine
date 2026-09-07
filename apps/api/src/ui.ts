import fastifyStatic from '@fastify/static';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type {
  BatchJobInput,
  BatchWithJobs,
  CreateBatchInput,
} from '../../../packages/database/src/batches.js';
import {
  analyzeRequestSchema,
  createBatchSchema,
  youtubeVideoId,
} from '../../../packages/shared/src/index.js';

const batchParams = z.object({ batchId: z.string().uuid() });
const jobParams = z.object({ jobId: z.string().uuid() });
const loginSchema = z.object({ password: z.string().min(1).max(500) }).strict();
const idempotencySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[\x21-\x7E]+$/);

export interface UiDependencies {
  createBatch(input: CreateBatchInput): Promise<{ batch: BatchWithJobs; created: boolean }>;
  listBatches(): Promise<BatchWithJobs[]>;
  getBatch(batchId: string): Promise<BatchWithJobs | null>;
  enqueue(jobId: string): Promise<void>;
  retryJob(jobId: string): Promise<void>;
  deliverBatch(batchId: string): Promise<BatchWithJobs>;
}

export async function registerUi(
  app: FastifyInstance,
  config: AppConfig,
  dependencies: UiDependencies,
): Promise<void> {
  if (!config.WEB_UI_ENABLED) return;

  await app.register(fastifyStatic, {
    root: resolve(config.WEB_ASSETS_PATH),
    prefix: '/',
    index: false,
    cacheControl: true,
    maxAge: '1h',
  });

  app.get('/', async (_request, reply) => reply.sendFile('index.html', { maxAge: 0 }));

  app.get('/ui-api/session', async (request, reply) => {
    if (!hasValidSession(request, config)) return unauthorized(reply);
    return { authenticated: true };
  });

  app.post(
    '/ui-api/session',
    { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const { password } = loginSchema.parse(request.body);
      if (!safeEqual(password, config.WEB_ADMIN_PASSWORD)) return unauthorized(reply);
      const expiresAt = Math.floor(Date.now() / 1000) + config.WEB_SESSION_TTL_SECONDS;
      const token = sessionToken(config.ETM_API_SECRET, expiresAt);
      const secure = request.protocol === 'https';
      reply.header(
        'set-cookie',
        `etm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(config.WEB_SESSION_TTL_SECONDS)}${secure ? '; Secure' : ''}`,
      );
      return { authenticated: true };
    },
  );

  app.post(
    '/ui-api/session/logout',
    { preHandler: uiAuth(config, true) },
    async (_request, reply) => {
      reply.header('set-cookie', 'etm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return { authenticated: false };
    },
  );

  app.get('/ui-api/batches', { preHandler: uiAuth(config, false) }, async () => {
    const batches = await dependencies.listBatches();
    return { batches: batches.map((batch) => serializeBatch(batch, false)) };
  });

  app.get(
    '/ui-api/batches/:batchId',
    { preHandler: uiAuth(config, false) },
    async (request, reply) => {
      const { batchId } = batchParams.parse(request.params);
      const batch = await dependencies.getBatch(batchId);
      if (!batch) return reply.code(404).send({ message: 'Batch not found' });
      return serializeBatch(batch, true);
    },
  );

  app.post(
    '/ui-api/batches',
    {
      preHandler: uiAuth(config, true),
      config: { rateLimit: {} },
    },
    async (request, reply) => {
      const payload = createBatchSchema.parse(request.body);
      const idempotencyKey = idempotencySchema.parse(header(request, 'idempotency-key'));
      const normalized: BatchJobInput[] = payload.videos.map((video) => {
        const videoId = youtubeVideoId(video.source);
        if (!videoId) throw new UiRequestError(`No se reconoce el vídeo: ${video.source}`);
        return {
          videoId,
          payload: analyzeRequestSchema.parse({
            title: video.title,
            classDate: payload.classDate,
            teacher: payload.teacher,
            course: payload.course,
            analyzeVisuals: payload.analyzeVisuals,
          }),
        };
      });
      const duplicated = normalized.find(
        (job, index) =>
          normalized.findIndex((candidate) => candidate.videoId === job.videoId) !== index,
      );
      if (duplicated)
        throw new UiRequestError(`El vídeo ${duplicated.videoId} está repetido en el lote`);
      const raw = request.rawBody ?? Buffer.from(JSON.stringify(request.body));
      const result = await dependencies.createBatch({
        name: payload.name,
        idempotencyKey,
        payloadHash: createHash('sha256').update(raw).digest('hex'),
        jobs: normalized,
      });
      if (result.created) {
        await Promise.all(result.batch.jobs.map((job) => dependencies.enqueue(job.id)));
      }
      return reply.code(result.created ? 202 : 200).send(serializeBatch(result.batch, true));
    },
  );

  app.post(
    '/ui-api/jobs/:jobId/retry',
    { preHandler: uiAuth(config, true), config: { rateLimit: {} } },
    async (request, reply) => {
      const { jobId } = jobParams.parse(request.params);
      await dependencies.retryJob(jobId);
      return reply.code(202).send({ jobId, status: 'queued' });
    },
  );

  app.post(
    '/ui-api/batches/:batchId/deliver',
    { preHandler: uiAuth(config, true), config: { rateLimit: {} } },
    async (request) => {
      const { batchId } = batchParams.parse(request.params);
      return serializeBatch(await dependencies.deliverBatch(batchId), true);
    },
  );
}

export class UiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiRequestError';
  }
}

export class UiConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiConflictError';
  }
}

export class UiNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiNotFoundError';
  }
}

export class UiDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiDeliveryError';
  }
}

function uiAuth(config: AppConfig, mutation: boolean) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!hasValidSession(request, config)) {
      await unauthorized(reply);
      return;
    }
    if (mutation && header(request, 'x-etm-ui') !== '1') {
      await reply.code(403).send({ message: 'Request origin could not be verified' });
    }
  };
}

function hasValidSession(request: FastifyRequest, config: AppConfig): boolean {
  const cookies = (header(request, 'cookie') ?? '').split(';').map((item) => item.trim());
  const token = cookies
    .find((item) => item.startsWith('etm_session='))
    ?.slice('etm_session='.length);
  if (!token) return false;
  const [expiryText, signature] = token.split('.', 2);
  const expiry = Number(expiryText);
  if (!expiryText || !signature || !Number.isSafeInteger(expiry) || expiry <= Date.now() / 1000) {
    return false;
  }
  const expected = sessionSignature(config.ETM_API_SECRET, expiry);
  return safeEqual(signature, expected);
}

function sessionToken(secret: string, expiresAt: number): string {
  return `${String(expiresAt)}.${sessionSignature(secret, expiresAt)}`;
}

function sessionSignature(secret: string, expiresAt: number): string {
  return createHmac('sha256', secret)
    .update(`etm-web-session\n${String(expiresAt)}`)
    .digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

async function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({
    statusCode: 401,
    error: 'Unauthorized',
    message: 'Authentication required',
  });
}

function serializeBatch(batch: BatchWithJobs, includeAnalysis: boolean) {
  const completed = batch.jobs.filter((job) => job.status === 'completed').length;
  const failed = batch.jobs.filter((job) => job.status === 'failed').length;
  const active = batch.jobs.length - completed - failed;
  const progress = batch.jobs.length
    ? Math.round(batch.jobs.reduce((total, job) => total + job.progress, 0) / batch.jobs.length)
    : 0;
  const status = active > 0 ? 'processing' : failed > 0 ? 'attention' : 'ready';
  return {
    id: batch.id,
    name: batch.name,
    status,
    progress,
    counts: { total: batch.jobs.length, completed, failed, active },
    delivery: {
      status: batch.deliveryStatus,
      attempts: batch.deliveryAttempts,
      lastError: batch.deliveryLastError,
      deliveredAt: batch.deliveredAt,
    },
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    jobs: batch.jobs.map((job) => {
      const submission = analyzeRequestSchema.safeParse(job.requestPayload);
      return {
        id: job.id,
        videoId: job.videoId,
        order: job.batchOrder,
        status: job.status,
        progress: job.progress,
        submission: submission.success ? submission.data : null,
        warnings: job.warnings ?? [],
        error:
          job.status === 'failed'
            ? {
                code: job.errorCode ?? 'PROCESSING_FAILED',
                message: job.errorMessage ?? 'Processing failed',
              }
            : null,
        analysis: includeAnalysis && job.status === 'completed' ? job.resultJson : null,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        updatedAt: job.updatedAt,
      };
    }),
  };
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
