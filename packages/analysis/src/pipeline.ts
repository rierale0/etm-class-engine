import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import {
  analyzeRequestSchema,
  type AnalyzeRequest,
  type ClassAnalysis,
  type JobStatus,
  type ProcessingWarning,
  type TranscriptSegment,
  type VisualObservation,
} from '../../shared/src/index.js';
import { CallbackSender } from './callback.js';
import { PipelineError, sanitizedError } from './errors.js';
import type { AudioChunk, MediaProcessor, VideoFrame } from './media.js';
import type { ChunkTranscription } from './transcript.js';
import { normalizeTranscriptions } from './transcript.js';
import type { YoutubeClient, YoutubeMetadata } from './youtube.js';

export interface PipelineJob {
  id: string;
  videoId: string;
  batchId: string | null;
  requestPayload: unknown;
}

export interface JobStore {
  get(id: string): Promise<PipelineJob | null>;
  stage(id: string, status: JobStatus, progress: number, attempt: number): Promise<void>;
  saveResult(
    id: string,
    analysis: ClassAnalysis,
    characterCount: number,
    warnings: ProcessingWarning[],
  ): Promise<void>;
  complete(id: string, callbackAttempts: number): Promise<void>;
  fail(id: string, error: PipelineError): Promise<void>;
  retry(id: string, error: PipelineError): Promise<void>;
  callbackFailed(id: string, error: PipelineError): Promise<void>;
  callbackSent(id: string, attempts: number): Promise<void>;
  isCancelled(id: string): Promise<boolean>;
}

export interface YoutubePort {
  getMetadata(videoId: string): Promise<YoutubeMetadata>;
  download(videoId: string, directory: string, includeVideo: boolean): Promise<string>;
}

export interface MediaPort {
  assertDiskSpace(directory: string): Promise<void>;
  extractAudioChunks(
    input: string,
    directory: string,
    durationSeconds: number,
    chunkSeconds: number,
    overlapSeconds: number,
  ): Promise<AudioChunk[]>;
  extractFrames(
    input: string,
    directory: string,
    durationSeconds: number,
    maximumFrames: number,
  ): Promise<VideoFrame[]>;
}

export interface AiPort {
  transcribeChunk(
    path: string,
    teacher: string,
    previousContext: string,
  ): Promise<ChunkTranscription>;
  analyzeFrames(frames: VideoFrame[]): Promise<VisualObservation[]>;
  synthesize(input: {
    videoId: string;
    request: AnalyzeRequest;
    metadata: YoutubeMetadata;
    transcript: TranscriptSegment[];
    visuals: VisualObservation[];
    warnings: ProcessingWarning[];
    visualAnalysisEnabled: boolean;
  }): Promise<ClassAnalysis>;
}

export interface CallbackPort {
  send(payload: unknown, callbackId?: string): ReturnType<CallbackSender['send']>;
}

export interface PipelineOptions {
  jobDataRoot: string;
  chunkSeconds: number;
  overlapSeconds: number;
  visualAnalysisEnabled: boolean;
  maximumFrames: number;
  maximumJsonCharacters: number;
}

export interface ProcessContext {
  attempt: number;
  maximumAttempts: number;
}

export class ClassPipeline {
  constructor(
    private readonly store: JobStore,
    private readonly youtube: YoutubePort,
    private readonly media: MediaPort,
    private readonly ai: AiPort,
    private readonly callback: CallbackPort,
    private readonly options: PipelineOptions,
    private readonly logger: Logger,
  ) {}

  async process(jobId: string, context: ProcessContext): Promise<void> {
    const job = await this.store.get(jobId);
    if (!job) throw new PipelineError('INTERNAL_ERROR', 'The durable job was not found', false);
    const request = analyzeRequestSchema.parse(job.requestPayload);
    const directory = join(this.options.jobDataRoot, job.id);
    const started = Date.now();
    let stage: JobStatus = 'queued';

    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await this.media.assertDiskSpace(this.options.jobDataRoot);
      await this.checkCancellation(job.id);

      stage = 'validating_video';
      await this.store.stage(job.id, stage, 5, context.attempt);
      const metadata = await this.youtube.getMetadata(job.videoId);

      stage = 'downloading';
      await this.store.stage(job.id, stage, 15, context.attempt);
      const visualEnabled = this.options.visualAnalysisEnabled && request.analyzeVisuals;
      const mediaPath = await this.youtube.download(job.videoId, directory, visualEnabled);
      await this.checkCancellation(job.id);

      stage = 'extracting_audio';
      await this.store.stage(job.id, stage, 30, context.attempt);
      const chunks = await this.media.extractAudioChunks(
        mediaPath,
        directory,
        metadata.duration,
        this.options.chunkSeconds,
        this.options.overlapSeconds,
      );

      stage = 'transcribing';
      await this.store.stage(job.id, stage, 45, context.attempt);
      const transcriptions = [];
      let priorContext = '';
      for (const chunk of chunks) {
        await this.checkCancellation(job.id);
        const transcription = await this.ai.transcribeChunk(
          chunk.path,
          request.teacher,
          priorContext,
        );
        transcriptions.push(transcription);
        priorContext = `${priorContext} ${transcription.text}`.slice(-2_000);
      }
      const normalized = normalizeTranscriptions(chunks, transcriptions);

      let visuals: VisualObservation[] = [];
      if (visualEnabled) {
        stage = 'extracting_frames';
        await this.store.stage(job.id, stage, 65, context.attempt);
        const frames = await this.media.extractFrames(
          mediaPath,
          directory,
          metadata.duration,
          this.options.maximumFrames,
        );
        stage = 'analyzing_visuals';
        await this.store.stage(job.id, stage, 75, context.attempt);
        visuals = await this.ai.analyzeFrames(frames);
      }

      stage = 'synthesizing';
      await this.store.stage(job.id, stage, 82, context.attempt);
      const analysis = await this.ai.synthesize({
        videoId: job.videoId,
        request,
        metadata,
        transcript: normalized.segments,
        visuals,
        warnings: normalized.warnings,
        visualAnalysisEnabled: visualEnabled,
      });
      const serialized = JSON.stringify(analysis);
      const characterCount = serialized.length;
      const warnings = [...normalized.warnings];
      if (characterCount > this.options.maximumJsonCharacters) {
        warnings.push({
          code: 'ANALYSIS_OVERSIZE',
          message: `Analysis contains ${String(characterCount)} characters and exceeds the configured ${String(this.options.maximumJsonCharacters)}-character downstream limit`,
        });
      }
      await this.store.saveResult(job.id, analysis, characterCount, warnings);

      if (job.batchId) {
        await this.store.complete(job.id, 0);
      } else {
        stage = 'sending_callback';
        await this.store.stage(job.id, stage, 95, context.attempt);
        try {
          const callback = await this.callback.send(
            {
              jobId: job.id,
              videoId: job.videoId,
              status: 'completed',
              analysis,
              analysisCharacterCount: characterCount,
              error: null,
            },
            `job-${job.id}-completed`,
          );
          await this.store.complete(job.id, callback.attempts);
        } catch (callbackError) {
          const error = sanitizedError(callbackError);
          await this.store.complete(job.id, 0);
          await this.store.callbackFailed(job.id, error);
          this.logger.error(
            {
              jobId: job.id,
              videoId: job.videoId,
              stage: 'sending_callback',
              errorCode: error.code,
              err: { name: error.name, message: error.message },
            },
            'Analysis completed but callback delivery failed',
          );
        }
      }
      this.logger.info({
        jobId: job.id,
        videoId: job.videoId,
        stage: 'completed',
        durationMs: Date.now() - started,
        attempt: context.attempt,
        audioChunks: chunks.length,
        frameCount: visuals.length,
        resultCharacterCount: characterCount,
      });
    } catch (unknownError) {
      const error = sanitizedError(unknownError);
      const finalFailure = !error.retryable || context.attempt >= context.maximumAttempts;
      if (finalFailure) {
        await this.store.fail(job.id, error);
        if (!job.batchId) {
          try {
            const callbackResult = await this.callback.send(
              {
                jobId: job.id,
                videoId: job.videoId,
                status: 'failed',
                analysis: null,
                error: { code: error.code, message: error.message },
              },
              `job-${job.id}-failed`,
            );
            await this.store.callbackSent(job.id, callbackResult.attempts);
          } catch (callbackError) {
            await this.store.callbackFailed(job.id, sanitizedError(callbackError));
          }
        }
      } else {
        await this.store.retry(job.id, error);
      }
      this.logger.error({
        jobId: job.id,
        videoId: job.videoId,
        stage,
        durationMs: Date.now() - started,
        attempt: context.attempt,
        errorCode: error.code,
        err: { name: error.name, message: error.message },
      });
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(
        (cleanupError: unknown) => {
          this.logger.error({
            jobId: job.id,
            videoId: job.videoId,
            stage: 'cleanup',
            err: cleanupError,
          });
        },
      );
    }
  }

  private async checkCancellation(jobId: string): Promise<void> {
    if (await this.store.isCancelled(jobId)) {
      throw new PipelineError('JOB_CANCELLED', 'The job was cancelled', false);
    }
  }
}

export function createProductionPipelinePorts(input: {
  youtube: YoutubeClient;
  media: MediaProcessor;
  ai: AiPort;
  callback: CallbackSender;
}): Pick<ClassPipeline, never> {
  // Compile-time guard: concrete adapters satisfy the pipeline ports.
  const _youtube: YoutubePort = input.youtube;
  const _media: MediaPort = input.media;
  const _ai: AiPort = input.ai;
  const _callback: CallbackPort = input.callback;
  void [_youtube, _media, _ai, _callback];
  return {};
}
