import { describe, expect, it, vi } from 'vitest';
import type { AiPort } from './pipeline.js';
import { AiRouter } from './ai-router.js';

function provider(label: string): AiPort {
  return {
    transcribeChunk: vi.fn().mockResolvedValue({ text: label, segments: [] }),
    analyzeFrames: vi
      .fn()
      .mockResolvedValue([{ timestamp: label, description: label, relevance: label }]),
    synthesize: vi.fn().mockResolvedValue({ provider: label }),
  };
}

describe('AiRouter', () => {
  it('routes each pipeline stage independently', async () => {
    const transcription = provider('transcription');
    const analysis = provider('analysis');
    const visual = provider('visual');
    const router = new AiRouter(transcription, analysis, visual);

    await expect(router.transcribeChunk('/audio.mp3', 'Teacher', '')).resolves.toMatchObject({
      text: 'transcription',
    });
    await expect(router.analyzeFrames([])).resolves.toEqual([
      expect.objectContaining({ timestamp: 'visual' }),
    ]);
    await router.synthesize({} as Parameters<AiPort['synthesize']>[0]);

    expect(transcription.transcribeChunk).toHaveBeenCalledOnce();
    expect(visual.analyzeFrames).toHaveBeenCalledOnce();
    expect(analysis.synthesize).toHaveBeenCalledOnce();
  });
});
