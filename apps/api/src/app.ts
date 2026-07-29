import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import rawBody from 'fastify-raw-body';
import { z, ZodError } from 'zod';
import { csv, type AppConfig } from '../../../packages/config/src/index.js';
import {
  ActiveVideoJobError,
  IdempotencyConflictError,
  type CreateAnalysisBatchInput,
  type CreatedAnalysisBatch,
  type CreatedJob,
  type CreateJobInput,
} from '../../../packages/database/src/index.js';
import {
  isIpAllowed,
  parseCidrs,
  requestPayloadHash,
  verifyRequestSignature,
} from '../../../packages/security/src/index.js';
import {
  analyzeRequestSchema,
  assembleBatchResult,
  videoIdSchema,
  youtubeVideoId,
} from '../../../packages/shared/src/index.js';
import { localAppCss, localAppHtml, localAppJavaScript } from './ui-assets.js';

export interface ApiJobView {
  id: string;
  videoId: string;
  status: string;
  progress: number;
  requestPayload: unknown;
  resultJson?: unknown;
  resultCharacterCount: number | null;
  warnings: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  callbackStatus: string;
  callbackAttempts: number;
  callbackLastError: string | null;
  batchId: string | null;
  batchPosition: number | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface ApiBatchView {
  id: string;
  name: string;
  callbackStatus: string;
  callbackAttempts: number;
  callbackLastError: string | null;
  resultHash: string | null;
  resultCharacterCount: number | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  jobs: ApiJobView[];
}

export interface ApiDependencies {
  createJob(input: CreateJobInput): Promise<CreatedJob>;
  createBatch(input: CreateAnalysisBatchInput): Promise<CreatedAnalysisBatch>;
  enqueue(jobId: string): Promise<void>;
  enqueueMany(jobIds: string[]): Promise<void>;
  getJob(jobId: string): Promise<ApiJobView | null>;
  getBatch(batchId: string): Promise<ApiBatchView | null>;
  listBatches(limit: number): Promise<ApiBatchView[]>;
  enqueueBatchSend(batchId: string): Promise<boolean>;
  enqueueBatchJobRetry(batchId: string, jobId: string): Promise<boolean>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

const jobIdParams = z.object({ jobId: z.string().uuid() });
const batchIdParams = z.object({ batchId: z.string().uuid() });
const batchJobParams = z.object({
  batchId: z.string().uuid(),
  jobId: z.string().uuid(),
});
const analyzeParams = z.object({ videoId: videoIdSchema });
const localListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });
const localAnalyzeRequestSchema = analyzeRequestSchema
  .extend({
    videoUrl: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .refine((value) => {
        try {
          youtubeVideoId(value);
          return true;
        } catch {
          return false;
        }
      }, 'A valid YouTube video URL is required'),
  })
  .strict();
const localBatchRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    videos: z.array(localAnalyzeRequestSchema).min(1),
  })
  .strict();
const idempotencySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[\x21-\x7E]+$/);

export async function buildApp(
  config: AppConfig,
  dependencies: ApiDependencies,
  logger?: FastifyBaseLogger,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      logger ??
      ({
        level: config.LOG_LEVEL,
        redact: {
          paths: [
            'req.headers["x-etm-signature"]',
            'req.headers.authorization',
            'req.headers.cookie',
            '*.apiKey',
            '*.secret',
          ],
          censor: '[REDACTED]',
        },
      } as const),
    trustProxy: csv(config.CADDY_TRUSTED_PROXIES),
    bodyLimit: 64 * 1024,
    requestIdHeader: false,
  });

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        upgradeInsecureRequests: config.LOCAL_UI_ENABLED ? null : [],
      },
    },
  });
  await app.register(rawBody, {
    field: 'rawBody',
    global: true,
    encoding: false,
    runFirst: true,
  });
  await app.register(rateLimit, {
    global: false,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded',
    }),
  });

  const allowedCidrs = parseCidrs(csv(config.ALLOWED_CIDRS));

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const timestamp = header(request, 'x-etm-timestamp');
    const signature = header(request, 'x-etm-signature');
    const raw = request.rawBody ?? Buffer.alloc(0);
    const allowed = isIpAllowed(request.ip, allowedCidrs);
    const valid =
      allowed &&
      timestamp !== undefined &&
      signature !== undefined &&
      verifyRequestSignature({
        secret: config.ETM_API_SECRET,
        timestamp,
        signature,
        method: request.method,
        requestPath: request.url,
        rawBody: raw,
      });
    if (!valid) {
      await reply.code(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Authentication failed',
      });
    }
  }

  app.get('/health', () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    try {
      await dependencies.ready();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  if (config.LOCAL_UI_ENABLED) {
    app.get('/', async (_request, reply) =>
      reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(localAppHtml),
    );
    app.get('/ui/app.css', async (_request, reply) =>
      reply.header('cache-control', 'no-store').type('text/css; charset=utf-8').send(localAppCss),
    );
    app.get('/ui/app.js', async (_request, reply) =>
      reply
        .header('cache-control', 'no-store')
        .type('application/javascript; charset=utf-8')
        .send(localAppJavaScript),
    );
    app.get('/ui/config', () => ({
      visualAnalysisEnabled: config.ENABLE_VISUAL_ANALYSIS,
      maximumBatchVideos: config.MAX_BATCH_VIDEOS,
    }));

    app.post('/ui/batches', { preHandler: requireLocalOrigin }, async (request, reply) => {
      const localRequest = localBatchRequestSchema.parse(request.body);
      if (localRequest.videos.length > config.MAX_BATCH_VIDEOS) {
        return reply.code(400).send({
          message: `A batch can contain at most ${String(config.MAX_BATCH_VIDEOS)} videos`,
        });
      }
      if (
        localRequest.videos.some((video) => video.analyzeVisuals) &&
        !config.ENABLE_VISUAL_ANALYSIS
      ) {
        return reply.code(409).send({
          message: 'Visual analysis is disabled in the application configuration',
        });
      }
      const items = localRequest.videos.map((video) => ({
        videoId: youtubeVideoId(video.videoUrl),
        payload: analyzeRequestSchema.parse({
          title: video.title,
          classDate: video.classDate,
          teacher: video.teacher,
          course: video.course,
          analyzeVisuals: video.analyzeVisuals,
        }),
      }));
      if (new Set(items.map((item) => item.videoId)).size !== items.length) {
        return reply.code(400).send({ message: 'A batch cannot contain duplicate videos' });
      }
      const result = await dependencies.createBatch({
        name: localRequest.name,
        items,
      });
      await dependencies.enqueueMany(result.batch.jobs.map((job) => job.id));
      return reply.code(202).send({
        batchId: result.batch.id,
        status: 'processing',
        jobIds: result.batch.jobs.map((job) => job.id),
      });
    });

    app.get('/ui/batches', async (request) => {
      const { limit } = localListQuery.parse(request.query);
      const batches = await dependencies.listBatches(limit);
      return { batches: batches.map((batch) => localBatchView(batch, false)) };
    });

    app.get('/ui/batches/:batchId', async (request, reply) => {
      const { batchId } = batchIdParams.parse(request.params);
      const batch = await dependencies.getBatch(batchId);
      if (!batch) return reply.code(404).send({ message: 'Batch not found' });
      const view = localBatchView(batch, true);
      if (view.result) assertBatchSize(view.result, config.MAX_BATCH_JSON_BYTES);
      return view;
    });

    app.get('/ui/batches/:batchId/result', async (request, reply) => {
      const { batchId } = batchIdParams.parse(request.params);
      const batch = await dependencies.getBatch(batchId);
      if (!batch) return reply.code(404).send({ message: 'Batch not found' });
      if (batchStatus(batch.jobs) !== 'ready') {
        return reply.code(409).send({ message: 'The batch result is not available yet' });
      }
      const result = assembleBatchResult(batch);
      assertBatchSize(result, config.MAX_BATCH_JSON_BYTES);
      return reply
        .header('cache-control', 'no-store')
        .header('content-disposition', `attachment; filename="etm-batch-${batch.id}.json"`)
        .type('application/json; charset=utf-8')
        .send(result);
    });

    app.post(
      '/ui/batches/:batchId/send',
      { preHandler: requireLocalOrigin },
      async (request, reply) => {
        const { batchId } = batchIdParams.parse(request.params);
        const batch = await dependencies.getBatch(batchId);
        if (!batch) return reply.code(404).send({ message: 'Batch not found' });
        if (batchStatus(batch.jobs) !== 'ready') {
          return reply.code(409).send({ message: 'Every class must complete before sending' });
        }
        const result = assembleBatchResult(batch);
        assertBatchSize(result, config.MAX_BATCH_JSON_BYTES);
        if (!['not_sent', 'failed'].includes(batch.callbackStatus)) {
          return reply.code(409).send({ message: 'This batch is already sending or sent' });
        }
        if (!(await dependencies.enqueueBatchSend(batchId))) {
          return reply.code(409).send({ message: 'This batch is already sending or sent' });
        }
        return reply.code(202).send({ batchId, callbackStatus: 'pending' });
      },
    );

    app.post(
      '/ui/batches/:batchId/jobs/:jobId/retry',
      { preHandler: requireLocalOrigin },
      async (request, reply) => {
        const { batchId, jobId } = batchJobParams.parse(request.params);
        if (!(await dependencies.enqueueBatchJobRetry(batchId, jobId))) {
          return reply.code(409).send({ message: 'Only a failed class can be retried' });
        }
        return reply.code(202).send({ batchId, jobId, status: 'queued' });
      },
    );
  }

  app.post(
    '/v1/classes/:videoId/analyze',
    {
      preHandler: authenticate,
      config: { rateLimit: {} },
    },
    async (request, reply) => {
      const { videoId } = analyzeParams.parse(request.params);
      const payload = analyzeRequestSchema.parse(request.body);
      const idempotencyKey = idempotencySchema.parse(header(request, 'idempotency-key'));
      const raw = request.rawBody ?? Buffer.from(JSON.stringify(request.body));
      const result = await dependencies.createJob({
        videoId,
        payload,
        idempotencyKey,
        payloadHash: requestPayloadHash(request.method, request.url, raw),
      });
      if (result.created) await dependencies.enqueue(result.job.id);
      return reply.code(202).send({
        jobId: result.job.id,
        videoId: result.job.videoId,
        status: result.job.status,
        statusUrl: `/v1/jobs/${result.job.id}`,
      });
    },
  );

  app.get(
    '/v1/jobs/:jobId',
    {
      preHandler: authenticate,
      config: { rateLimit: {} },
    },
    async (request, reply) => {
      const { jobId } = jobIdParams.parse(request.params);
      const job = await dependencies.getJob(jobId);
      if (!job) return reply.code(404).send({ message: 'Job not found' });
      return {
        jobId: job.id,
        videoId: job.videoId,
        status: job.status,
        progress: job.progress,
        timestamps: {
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          updatedAt: job.updatedAt,
        },
        callbackStatus: job.callbackStatus,
        analysisCharacterCount: job.resultCharacterCount,
        warnings: job.warnings ?? [],
        error:
          job.errorCode && job.status === 'failed'
            ? { code: job.errorCode, message: job.errorMessage ?? 'Processing failed' }
            : null,
        analysis: job.status === 'completed' ? job.resultJson : null,
      };
    },
  );

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Request validation failed',
      });
      return;
    }
    if (error instanceof IdempotencyConflictError) {
      void reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: error.message,
      });
      return;
    }
    if (error instanceof ActiveVideoJobError) {
      void reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: error.message,
        activeJobId: error.jobId,
      });
      return;
    }
    if (error instanceof BatchResultTooLargeError) {
      void reply.code(413).send({
        statusCode: 413,
        error: 'Payload Too Large',
        message: error.message,
        bytes: error.bytes,
        maximumBytes: error.maximumBytes,
      });
      return;
    }
    app.log.error({ err: error }, 'Unhandled API error');
    void reply.code(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'An internal error occurred',
    });
  });

  async function requireLocalOrigin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const origin = header(request, 'origin');
    const allowedOrigins = new Set([
      config.LOCAL_UI_ORIGIN,
      config.LOCAL_UI_ORIGIN.replace('://localhost', '://127.0.0.1'),
    ]);
    if (!origin || !allowedOrigins.has(origin)) {
      await reply.code(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Invalid local origin',
      });
    }
  }

  app.addHook('onClose', async () => dependencies.close());
  return app;
}

function localJobView(job: ApiJobView, includeAnalysis: boolean): object {
  const request = analyzeRequestSchema.safeParse(job.requestPayload);
  const withResult = job as Partial<ApiJobView>;
  return {
    jobId: job.id,
    videoId: job.videoId,
    videoUrl: `https://www.youtube.com/watch?v=${job.videoId}`,
    status: job.status,
    progress: job.progress,
    request: request.success ? request.data : null,
    timestamps: {
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      updatedAt: job.updatedAt,
    },
    callback: {
      status: job.callbackStatus,
      attempts: job.callbackAttempts,
      lastError: job.callbackLastError,
    },
    warnings: job.warnings ?? [],
    error:
      job.errorCode && job.status === 'failed'
        ? { code: job.errorCode, message: job.errorMessage ?? 'Processing failed' }
        : null,
    resultAvailable:
      job.status === 'completed' &&
      (includeAnalysis ? withResult.resultJson !== null : job.resultCharacterCount !== null),
    analysis:
      includeAnalysis && job.status === 'completed' ? (withResult.resultJson ?? null) : null,
  };
}

function batchStatus(jobs: ApiJobView[]): 'processing' | 'ready' | 'attention_required' {
  if (jobs.length > 0 && jobs.every((job) => job.status === 'completed')) return 'ready';
  if (jobs.some((job) => job.status === 'failed')) return 'attention_required';
  return 'processing';
}

function localBatchView(
  batch: ApiBatchView,
  includeResult: boolean,
): {
  batchId: string;
  name: string;
  status: 'processing' | 'ready' | 'attention_required';
  progress: number;
  completedClasses: number;
  totalClasses: number;
  callback: { status: string; attempts: number; lastError: string | null; sentAt: Date | null };
  timestamps: { createdAt: Date; updatedAt: Date };
  resultAvailable: boolean;
  jobs: object[];
  result: ReturnType<typeof assembleBatchResult> | null;
} {
  const status = batchStatus(batch.jobs);
  const progress =
    batch.jobs.length === 0
      ? 0
      : Math.round(batch.jobs.reduce((total, job) => total + job.progress, 0) / batch.jobs.length);
  return {
    batchId: batch.id,
    name: batch.name,
    status,
    progress,
    completedClasses: batch.jobs.filter((job) => job.status === 'completed').length,
    totalClasses: batch.jobs.length,
    callback: {
      status: batch.callbackStatus,
      attempts: batch.callbackAttempts,
      lastError: batch.callbackLastError,
      sentAt: batch.sentAt,
    },
    timestamps: { createdAt: batch.createdAt, updatedAt: batch.updatedAt },
    resultAvailable: status === 'ready',
    jobs: batch.jobs.map((job) => localJobView(job, false)),
    result: includeResult && status === 'ready' ? assembleBatchResult(batch) : null,
  };
}

function assertBatchSize(result: unknown, maximumBytes: number): void {
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes > maximumBytes) {
    throw new BatchResultTooLargeError(bytes, maximumBytes);
  }
}

class BatchResultTooLargeError extends Error {
  constructor(
    public readonly bytes: number,
    public readonly maximumBytes: number,
  ) {
    super('The combined batch JSON exceeds the configured size limit');
    this.name = 'BatchResultTooLargeError';
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
