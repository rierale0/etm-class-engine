import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { PipelineError } from '../../packages/analysis/src/errors.js';
import {
  ClassPipeline,
  type AiPort,
  type CallbackPort,
  type JobStore,
  type MediaPort,
  type PipelineJob,
  type YoutubePort,
} from '../../packages/analysis/src/pipeline.js';
import type {
  ClassAnalysis,
  JobStatus,
  ProcessingWarning,
} from '../../packages/shared/src/index.js';
import { validAnalysis } from '../fixtures/analysis.js';

class MemoryStore implements JobStore {
  job: PipelineJob = {
    id: '39f5a245-b69d-4b99-95e9-a0e43c5e9ef9',
    videoId: 'DEMOclass01',
    batchId: null,
    requestPayload: {
      title: 'ETM English Class',
      classDate: '2026-07-16',
      teacher: 'Alex Morgan',
      course: 'ETM English',
      analyzeVisuals: false,
    },
  };
  stages: JobStatus[] = [];
  analysis?: ClassAnalysis;
  characterCount?: number;
  warnings: ProcessingWarning[] = [];
  failure?: PipelineError;
  callbackFailure?: PipelineError;
  completedCallbackAttempts?: number;

  async get(): Promise<PipelineJob> {
    return this.job;
  }
  async stage(_id: string, status: JobStatus): Promise<void> {
    this.stages.push(status);
  }
  async saveResult(
    _id: string,
    analysis: ClassAnalysis,
    count: number,
    warnings: ProcessingWarning[],
  ): Promise<void> {
    this.analysis = analysis;
    this.characterCount = count;
    this.warnings = warnings;
  }
  async complete(_id: string, callbackAttempts: number): Promise<void> {
    this.completedCallbackAttempts = callbackAttempts;
    this.stages.push('completed');
  }
  async fail(_id: string, error: PipelineError): Promise<void> {
    this.failure = error;
    this.stages.push('failed');
  }
  async retry(_id: string, error: PipelineError): Promise<void> {
    this.failure = error;
    this.stages.push('queued');
  }
  async callbackFailed(_id: string, error: PipelineError): Promise<void> {
    this.callbackFailure = error;
  }
  async callbackSent(): Promise<void> {}
  async isCancelled(): Promise<boolean> {
    return false;
  }
}

function makePorts(): {
  youtube: YoutubePort;
  media: MediaPort;
  ai: AiPort;
  callback: CallbackPort;
} {
  return {
    youtube: {
      getMetadata: vi.fn().mockResolvedValue({
        id: 'DEMOclass01',
        title: 'Class',
        duration: 601,
        channel_id: 'UC-ETM',
      }),
      download: vi.fn().mockResolvedValue('/mock/audio.webm'),
    },
    media: {
      assertDiskSpace: vi.fn().mockResolvedValue(undefined),
      extractAudioChunks: vi.fn().mockResolvedValue([
        { chunkIndex: 0, startSeconds: 0, endSeconds: 600, path: '/mock/0.mp3' },
        { chunkIndex: 1, startSeconds: 597, endSeconds: 601, path: '/mock/1.mp3' },
      ]),
      extractFrames: vi.fn().mockResolvedValue([]),
    },
    ai: {
      transcribeChunk: vi
        .fn()
        .mockResolvedValueOnce({
          text: 'Welcome to ETM English',
          segments: [{ start: 0, end: 5, text: 'Welcome to ETM English' }],
        })
        .mockResolvedValueOnce({
          text: 'ETM English today',
          segments: [{ start: 0, end: 3, text: 'ETM English today' }],
        }),
      analyzeFrames: vi.fn().mockResolvedValue([]),
      synthesize: vi.fn<AiPort['synthesize']>().mockImplementation(async (input) => {
        const transcript = input.transcript
          .map((segment) => `[${segment.start} - ${segment.end}] ${segment.text}`)
          .join('\n');
        return validAnalysis(transcript);
      }),
    },
    callback: {
      send: vi.fn().mockResolvedValue({ attempts: 1, callbackId: 'callback-id' }),
    },
  };
}

describe('mocked class pipeline', () => {
  it('runs transcript-only end to end and removes temporary files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etm-pipeline-'));
    const store = new MemoryStore();
    const ports = makePorts();
    const pipeline = new ClassPipeline(
      store,
      ports.youtube,
      ports.media,
      ports.ai,
      ports.callback,
      {
        jobDataRoot: root,
        chunkSeconds: 600,
        overlapSeconds: 3,
        visualAnalysisEnabled: true,
        maximumFrames: 40,
        maximumJsonCharacters: 95_000,
      },
      pino({ level: 'silent' }),
    );
    await pipeline.process(store.job.id, { attempt: 1, maximumAttempts: 4 });

    expect(store.stages).toEqual([
      'validating_video',
      'downloading',
      'extracting_audio',
      'transcribing',
      'synthesizing',
      'sending_callback',
      'completed',
    ]);
    expect(ports.media.extractFrames).not.toHaveBeenCalled();
    expect(store.analysis?.transcript).toContain('Welcome to ETM English');
    expect(ports.callback.send).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        analysisCharacterCount: store.characterCount,
      }),
      `job-${store.job.id}-completed`,
    );
    await expect(access(join(root, store.job.id))).rejects.toThrow();
  });

  it('stores a batch class without sending an individual callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etm-batch-pipeline-'));
    const store = new MemoryStore();
    store.job.batchId = '6db014a1-f5ab-47d0-82c3-84e514f5db3d';
    const ports = makePorts();
    const pipeline = new ClassPipeline(
      store,
      ports.youtube,
      ports.media,
      ports.ai,
      ports.callback,
      {
        jobDataRoot: root,
        chunkSeconds: 600,
        overlapSeconds: 3,
        visualAnalysisEnabled: true,
        maximumFrames: 40,
        maximumJsonCharacters: 95_000,
      },
      pino({ level: 'silent' }),
    );

    await pipeline.process(store.job.id, { attempt: 1, maximumAttempts: 4 });

    expect(store.stages).toEqual([
      'validating_video',
      'downloading',
      'extracting_audio',
      'transcribing',
      'synthesizing',
      'completed',
    ]);
    expect(store.completedCallbackAttempts).toBe(0);
    expect(ports.callback.send).not.toHaveBeenCalled();
  });

  it('preserves oversized output and adds an exact warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etm-oversize-'));
    const store = new MemoryStore();
    const ports = makePorts();
    ports.ai.synthesize = vi.fn().mockResolvedValue(validAnalysis('x'.repeat(96_000)));
    const pipeline = new ClassPipeline(
      store,
      ports.youtube,
      ports.media,
      ports.ai,
      ports.callback,
      {
        jobDataRoot: root,
        chunkSeconds: 600,
        overlapSeconds: 3,
        visualAnalysisEnabled: false,
        maximumFrames: 40,
        maximumJsonCharacters: 95_000,
      },
      pino({ level: 'silent' }),
    );
    await pipeline.process(store.job.id, { attempt: 1, maximumAttempts: 1 });
    expect(store.analysis?.transcript).toHaveLength(96_000);
    expect(store.characterCount).toBeGreaterThan(95_000);
    expect(store.warnings).toEqual([
      expect.objectContaining({
        code: 'ANALYSIS_OVERSIZE',
        message: expect.stringContaining(String(store.characterCount)),
      }),
    ]);
  });

  it('keeps a completed analysis when callback delivery fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etm-callback-failure-'));
    const store = new MemoryStore();
    const ports = makePorts();
    ports.callback.send = vi
      .fn()
      .mockRejectedValue(new PipelineError('CALLBACK_FAILED', 'Callback unavailable', true));
    const pipeline = new ClassPipeline(
      store,
      ports.youtube,
      ports.media,
      ports.ai,
      ports.callback,
      {
        jobDataRoot: root,
        chunkSeconds: 600,
        overlapSeconds: 3,
        visualAnalysisEnabled: false,
        maximumFrames: 40,
        maximumJsonCharacters: 95_000,
      },
      pino({ level: 'silent' }),
    );

    await expect(
      pipeline.process(store.job.id, { attempt: 1, maximumAttempts: 4 }),
    ).resolves.toBeUndefined();

    expect(store.analysis).toBeDefined();
    expect(store.stages).toEqual([
      'validating_video',
      'downloading',
      'extracting_audio',
      'transcribing',
      'synthesizing',
      'sending_callback',
      'completed',
    ]);
    expect(store.completedCallbackAttempts).toBe(0);
    expect(store.callbackFailure?.code).toBe('CALLBACK_FAILED');
    expect(store.failure).toBeUndefined();
    expect(ports.ai.synthesize).toHaveBeenCalledOnce();
    await expect(access(join(root, store.job.id))).rejects.toThrow();
  });

  it('records a transcription failure and cleans up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etm-failure-'));
    const store = new MemoryStore();
    const ports = makePorts();
    ports.ai.transcribeChunk = vi
      .fn()
      .mockRejectedValue(new PipelineError('TRANSCRIPTION_FAILED', 'Transcription failed', false));
    const pipeline = new ClassPipeline(
      store,
      ports.youtube,
      ports.media,
      ports.ai,
      ports.callback,
      {
        jobDataRoot: root,
        chunkSeconds: 600,
        overlapSeconds: 3,
        visualAnalysisEnabled: false,
        maximumFrames: 40,
        maximumJsonCharacters: 95_000,
      },
      pino({ level: 'silent' }),
    );
    await expect(
      pipeline.process(store.job.id, { attempt: 1, maximumAttempts: 1 }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' });
    expect(store.failure?.code).toBe('TRANSCRIPTION_FAILED');
    await expect(access(join(root, store.job.id))).rejects.toThrow();
  });

  it('runs visual extraction and analysis only when both switches enable it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etm-visual-'));
    const store = new MemoryStore();
    store.job.requestPayload = {
      ...(store.job.requestPayload as Record<string, unknown>),
      analyzeVisuals: true,
    };
    const ports = makePorts();
    ports.media.extractFrames = vi
      .fn()
      .mockResolvedValue([{ timestampSeconds: 60, path: '/mock/frame.jpg' }]);
    ports.ai.analyzeFrames = vi.fn().mockResolvedValue([
      {
        timestamp: '00:01:00',
        description: 'A readable vocabulary slide',
        relevance: 'Lesson vocabulary',
      },
    ]);
    const pipeline = new ClassPipeline(
      store,
      ports.youtube,
      ports.media,
      ports.ai,
      ports.callback,
      {
        jobDataRoot: root,
        chunkSeconds: 600,
        overlapSeconds: 3,
        visualAnalysisEnabled: true,
        maximumFrames: 40,
        maximumJsonCharacters: 95_000,
      },
      pino({ level: 'silent' }),
    );
    await pipeline.process(store.job.id, { attempt: 1, maximumAttempts: 1 });
    expect(store.stages).toContain('extracting_frames');
    expect(store.stages).toContain('analyzing_visuals');
    expect(ports.media.extractFrames).toHaveBeenCalled();
    expect(ports.ai.analyzeFrames).toHaveBeenCalled();
    expect(ports.ai.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        visualAnalysisEnabled: true,
        visuals: [expect.objectContaining({ timestamp: '00:01:00' })],
      }),
    );
  });
});
