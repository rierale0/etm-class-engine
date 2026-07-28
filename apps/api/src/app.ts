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
  type CreatedJob,
  type CreateJobInput,
} from '../../../packages/database/src/index.js';
import {
  isIpAllowed,
  parseCidrs,
  requestPayloadHash,
  verifyRequestSignature,
} from '../../../packages/security/src/index.js';
import { analyzeRequestSchema, videoIdSchema } from '../../../packages/shared/src/index.js';

export interface ApiJobView {
  id: string;
  videoId: string;
  status: string;
  progress: number;
  resultJson: unknown;
  resultCharacterCount: number | null;
  warnings: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  callbackStatus: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface ApiDependencies {
  createJob(input: CreateJobInput): Promise<CreatedJob>;
  enqueue(jobId: string): Promise<void>;
  getJob(jobId: string): Promise<ApiJobView | null>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

const jobIdParams = z.object({ jobId: z.string().uuid() });
const analyzeParams = z.object({ videoId: videoIdSchema });
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

  await app.register(helmet, { global: true });
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

  app.addHook('onClose', async () => dependencies.close());
  return app;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
