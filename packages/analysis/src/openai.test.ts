import { describe, expect, it, vi } from 'vitest';
import { validAnalysis } from '../../../tests/fixtures/analysis.js';
import { OpenAiAnalyzer } from './openai.js';

describe('OpenAiAnalyzer', () => {
  it('attaches the complete transcript deterministically after validating the model response', async () => {
    const create = vi.fn(async (request: unknown) => {
      void request;
      return {
        output_text: JSON.stringify(validAnalysis('model-altered transcript')),
      };
    });
    const analyzer = new OpenAiAnalyzer({
      apiKey: 'openai-secret',
      transcriptionModel: 'whisper-1',
      analysisModel: 'gpt-5.6-sol',
      visualModel: 'gpt-5.6-sol',
      timeoutMs: 5_000,
    });
    const internals = analyzer as unknown as {
      client: { responses: { create: typeof create } };
    };
    internals.client.responses.create = create;

    await expect(
      analyzer.synthesize({
        videoId: 'DEMOclass01',
        request: {
          title: 'Class',
          classDate: '2026-07-16',
          teacher: 'Teacher',
          course: 'ETM English',
          analyzeVisuals: false,
        },
        metadata: {
          id: 'DEMOclass01',
          title: 'Class',
          duration: 2,
          channel_id: 'UC-ETM',
        },
        transcript: [{ start: '00:00:00', end: '00:00:02', speaker: null, text: 'Hello class' }],
        visuals: [],
        warnings: [],
        visualAnalysisEnabled: false,
      }),
    ).resolves.toMatchObject({
      transcript: '[00:00:00 - 00:00:02] Hello class',
    });

    const [request] = create.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      input: [
        {
          role: 'system',
          content: expect.stringContaining('Set the transcript field to an empty string'),
        },
        { role: 'user' },
      ],
    });
  });
});
