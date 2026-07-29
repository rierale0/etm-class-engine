import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import rawBody from 'fastify-raw-body';
import { z, ZodError } from 'zod';
import { csv, type AppConfig } from '../../../packages/config/src/index.js';
import {
  ActiveVideoJobError,
  IdempotencyConflictError,
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
  resultJson: unknown;
  resultCharacterCount: number | null;
  warnings: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  callbackStatus: string;
  callbackAttempts: number;
  callbackLastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export type ApiJobSummary = Omit<ApiJobView, 'resultJson'>;

export interface ApiDependencies {
  createJob(input: CreateJobInput): Promise<CreatedJob>;
  enqueue(jobId: string): Promise<void>;
  getJob(jobId: string): Promise<ApiJobView | null>;
  listJobs(limit: number): Promise<ApiJobSummary[]>;
  enqueueCallbackRetry(jobId: string): Promise<void>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

const jobIdParams = z.object({ jobId: z.string().uuid() });
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
    }));

    app.post('/ui/jobs', { preHandler: requireLocalOrigin }, async (request, reply) => {
      const localRequest = localAnalyzeRequestSchema.parse(request.body);
      if (localRequest.analyzeVisuals && !config.ENABLE_VISUAL_ANALYSIS) {
        return reply.code(409).send({
          message: 'Visual analysis is disabled in the application configuration',
        });
      }
      const videoId = youtubeVideoId(localRequest.videoUrl);
      const payload = analyzeRequestSchema.parse({
        title: localRequest.title,
        classDate: localRequest.classDate,
        teacher: localRequest.teacher,
        course: localRequest.course,
        analyzeVisuals: localRequest.analyzeVisuals,
      });
      const raw = Buffer.from(JSON.stringify(localRequest));
      const result = await dependencies.createJob({
        videoId,
        payload,
        idempotencyKey: `ui-${videoId}-${randomUUID()}`,
        payloadHash: requestPayloadHash('POST', '/ui/jobs', raw),
      });
      if (result.created) await dependencies.enqueue(result.job.id);
      return reply.code(202).send({
        jobId: result.job.id,
        videoId,
        status: result.job.status,
      });
    });

    app.get('/ui/jobs', async (request) => {
      const { limit } = localListQuery.parse(request.query);
      const jobs = await dependencies.listJobs(limit);
      return { jobs: jobs.map((job) => localJobView(job, false)) };
    });

    app.get('/ui/jobs/:jobId', async (request, reply) => {
      const { jobId } = jobIdParams.parse(request.params);
      const job = await dependencies.getJob(jobId);
      if (!job) return reply.code(404).send({ message: 'Job not found' });
      return localJobView(job, true);
    });

    app.get('/ui/jobs/:jobId/result', async (request, reply) => {
      const { jobId } = jobIdParams.parse(request.params);
      const job = await dependencies.getJob(jobId);
      if (!job) return reply.code(404).send({ message: 'Job not found' });
      if (job.status !== 'completed' || job.resultJson === null) {
        return reply.code(409).send({ message: 'The result is not available yet' });
      }
      return reply
        .header('cache-control', 'no-store')
        .header('content-disposition', `attachment; filename="etm-analysis-${job.videoId}.json"`)
        .type('application/json; charset=utf-8')
        .send(job.resultJson);
    });

    app.post(
      '/ui/jobs/:jobId/retry-callback',
      { preHandler: requireLocalOrigin },
      async (request, reply) => {
        const { jobId } = jobIdParams.parse(request.params);
        const job = await dependencies.getJob(jobId);
        if (!job) return reply.code(404).send({ message: 'Job not found' });
        if (!['completed', 'failed'].includes(job.status) || job.callbackStatus !== 'failed') {
          return reply.code(409).send({ message: 'This callback cannot be retried' });
        }
        await dependencies.enqueueCallbackRetry(jobId);
        return reply.code(202).send({ jobId, callbackStatus: 'pending' });
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

function localJobView(job: ApiJobSummary | ApiJobView, includeAnalysis: boolean): object {
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

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
