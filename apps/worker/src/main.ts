import { mkdir, writeFile } from 'node:fs/promises';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { pino } from 'pino';
import { AiRouter } from '../../../packages/analysis/src/ai-router.js';
import { CallbackSender } from '../../../packages/analysis/src/callback.js';
import { PipelineError } from '../../../packages/analysis/src/errors.js';
import { GeminiAnalyzer } from '../../../packages/analysis/src/gemini.js';
import { MediaProcessor } from '../../../packages/analysis/src/media.js';
import { OpenAiAnalyzer } from '../../../packages/analysis/src/openai.js';
import { ClassPipeline, type AiPort } from '../../../packages/analysis/src/pipeline.js';
import { YoutubeClient } from '../../../packages/analysis/src/youtube.js';
import {
  csv,
  loadConfig,
  resolveAiProviders,
  type AiProviderName,
} from '../../../packages/config/src/index.js';
import { createDatabase } from '../../../packages/database/src/index.js';
import { PrismaJobStore } from '../../../packages/database/src/job-store.js';
import { queueName } from '../../../packages/shared/src/index.js';

const config = loadConfig();
const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: ['*.apiKey', '*.secret', '*.signature', '*.cookies', '*.transcript', '*.analysis'],
    censor: '[REDACTED]',
  },
});
const database = createDatabase();
const store = new PrismaJobStore(database);
const redisUrl = new URL(config.REDIS_URL);
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {}),
  ...(redisUrl.username ? { username: decodeURIComponent(redisUrl.username) } : {}),
  ...(redisUrl.protocol === 'rediss:' ? { tls: {} } : {}),
};
const queue = new Queue<{ jobId: string }>(queueName, { connection });

await mkdir(config.JOB_DATA_ROOT, { recursive: true, mode: 0o700 });

const selectedProviders = resolveAiProviders(config);
const providerInstances = new Map<AiProviderName, AiPort>();
function getProvider(name: AiProviderName): AiPort {
  const existing = providerInstances.get(name);
  if (existing) return existing;
  const provider =
    name === 'openai'
      ? new OpenAiAnalyzer({
          apiKey: config.OPENAI_API_KEY,
          transcriptionModel: config.OPENAI_TRANSCRIPTION_MODEL,
          analysisModel: config.OPENAI_ANALYSIS_MODEL,
          visualModel: config.OPENAI_VISUAL_MODEL,
          timeoutMs: config.OPENAI_REQUEST_TIMEOUT_MS,
        })
      : new GeminiAnalyzer({
          apiKey: config.GEMINI_API_KEY,
          baseUrl: config.GEMINI_BASE_URL,
          transcriptionModel: config.GEMINI_TRANSCRIPTION_MODEL,
          analysisModel: config.GEMINI_ANALYSIS_MODEL,
          visualModel: config.GEMINI_VISUAL_MODEL,
          timeoutMs: config.GEMINI_REQUEST_TIMEOUT_MS,
        });
  providerInstances.set(name, provider);
  return provider;
}

const ai = new AiRouter(
  getProvider(selectedProviders.transcription),
  getProvider(selectedProviders.analysis),
  getProvider(selectedProviders.visual),
);
logger.info(
  {
    transcriptionProvider: selectedProviders.transcription,
    analysisProvider: selectedProviders.analysis,
    visualProvider: selectedProviders.visual,
  },
  'AI providers configured',
);

const pipeline = new ClassPipeline(
  store,
  new YoutubeClient({
    cookiesPath: config.YOUTUBE_COOKIES_PATH,
    metadataTimeoutMs: config.YTDLP_METADATA_TIMEOUT_MS,
    downloadTimeoutMs: config.YTDLP_DOWNLOAD_TIMEOUT_MS,
    maxDurationSeconds: config.MAX_VIDEO_DURATION_SECONDS,
    allowedChannelIds: csv(config.ALLOWED_YOUTUBE_CHANNEL_IDS),
  }),
  new MediaProcessor(config.FFMPEG_TIMEOUT_MS, config.MIN_FREE_DISK_BYTES),
  ai,
  new CallbackSender(
    config.N8N_CALLBACK_URL,
    config.N8N_CALLBACK_SECRET,
    config.CALLBACK_MAX_ATTEMPTS,
  ),
  {
    jobDataRoot: config.JOB_DATA_ROOT,
    chunkSeconds: config.AUDIO_CHUNK_SECONDS,
    overlapSeconds: config.AUDIO_CHUNK_OVERLAP_SECONDS,
    visualAnalysisEnabled: config.ENABLE_VISUAL_ANALYSIS,
    maximumFrames: config.MAX_ANALYSIS_FRAMES,
    maximumJsonCharacters: config.MAX_ANALYSIS_JSON_CHARACTERS,
  },
  logger,
);

const worker = new Worker<{ jobId: string }>(
  queueName,
  async (bullJob) => {
    const attempt = bullJob.attemptsMade + 1;
    try {
      await pipeline.process(bullJob.data.jobId, {
        attempt,
        maximumAttempts: bullJob.opts.attempts ?? 1,
      });
    } catch (error) {
      if (error instanceof PipelineError && !error.retryable) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  },
  {
    connection,
    concurrency: config.WORKER_CONCURRENCY,
    lockDuration: 10 * 60_000,
    stalledInterval: 60_000,
    maxStalledCount: 2,
  },
);

worker.on('error', (error) => {
  logger.error({ err: error }, 'BullMQ worker error');
});
worker.on('failed', (job, error) => {
  logger.error(
    { jobId: job?.data.jobId, attempt: job?.attemptsMade, err: error },
    'Analysis queue attempt failed',
  );
});

const recoveryTimer = setInterval(() => void recoverStaleJobs(), 5 * 60_000);
recoveryTimer.unref();
const heartbeatPath = '/tmp/worker-heartbeat';
await writeFile(heartbeatPath, new Date().toISOString());
const heartbeatTimer = setInterval(() => {
  void writeFile(heartbeatPath, new Date().toISOString()).catch((error: unknown) => {
    logger.error({ err: error }, 'Worker heartbeat write failed');
  });
}, 30_000);
heartbeatTimer.unref();

async function recoverStaleJobs(): Promise<void> {
  const staleBefore = new Date(Date.now() - 30 * 60_000);
  const stale = await database.job.findMany({
    where: {
      status: {
        in: [
          'queued',
          'validating_video',
          'downloading',
          'extracting_audio',
          'transcribing',
          'extracting_frames',
          'analyzing_visuals',
          'synthesizing',
          'sending_callback',
        ],
      },
      updatedAt: { lt: staleBefore },
    },
    select: { id: true },
    take: 100,
  });
  for (const job of stale) {
    const existing = await queue.getJob(job.id);
    if (!existing) {
      await queue.add(
        'analyze-class',
        { jobId: job.id },
        {
          jobId: job.id,
          attempts: 4,
          backoff: { type: 'exponential', delay: 30_000 },
        },
      );
      logger.warn({ jobId: job.id, stage: 'stale_recovery' }, 'Recovered stale durable job');
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  clearInterval(recoveryTimer);
  clearInterval(heartbeatTimer);
  logger.info({ signal }, 'Worker shutdown requested');
  await worker.close();
  await queue.close();
  await database.$disconnect();
  process.exitCode = 0;
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'ETM worker started');
