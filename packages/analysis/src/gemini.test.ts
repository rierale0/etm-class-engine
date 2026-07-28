import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { validAnalysis } from '../../../tests/fixtures/analysis.js';
import { GeminiAnalyzer } from './gemini.js';

function geminiResponse(output: unknown): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function analyzer(fetchImplementation: typeof fetch): GeminiAnalyzer {
  return new GeminiAnalyzer(
    {
      apiKey: 'gemini-secret',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/',
      transcriptionModel: 'gemini-transcription',
      analysisModel: 'gemini-analysis',
      visualModel: 'gemini-visual',
      timeoutMs: 5_000,
    },
    fetchImplementation,
  );
}

describe('GeminiAnalyzer', () => {
  it('sends MP3 audio inline and parses timestamped transcription JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etm-gemini-'));
    const path = join(directory, 'chunk.mp3');
    await writeFile(path, Buffer.from('audio'));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      geminiResponse({
        text: 'Hello class',
        segments: [{ start: 0, end: 2.5, text: 'Hello class' }],
      }),
    );

    await expect(analyzer(fetchMock).transcribeChunk(path, 'Teacher', '')).resolves.toEqual({
      text: 'Hello class',
      segments: [{ start: 0, end: 2.5, text: 'Hello class' }],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-transcription:generateContent',
    );
    expect(new Headers(request?.headers).get('x-goog-api-key')).toBe('gemini-secret');
    const rawBody = request?.body;
    if (typeof rawBody !== 'string') throw new Error('Expected a JSON request body');
    const body = JSON.parse(rawBody) as {
      contents: Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }>;
    };
    expect(body.contents[0]?.parts[1]?.inlineData).toEqual({
      mimeType: 'audio/mpeg',
      data: Buffer.from('audio').toString('base64'),
    });
  });

  it('validates final analysis and converts JSON Schema const to a Gemini enum', async () => {
    const transcript = '[00:00:00 - 00:00:02] Hello class';
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(geminiResponse(validAnalysis('model-altered transcript')));

    await expect(
      analyzer(fetchMock).synthesize({
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
    ).resolves.toMatchObject({ transcript });

    const [, request] = fetchMock.mock.calls[0] ?? [];
    const rawBody = request?.body;
    if (typeof rawBody !== 'string') throw new Error('Expected a JSON request body');
    const body = JSON.parse(rawBody) as {
      generationConfig: {
        responseJsonSchema: {
          properties: { schema_version: { enum: number[]; const?: number } };
        };
      };
    };
    expect(body.generationConfig.responseJsonSchema.properties.schema_version).toEqual({
      type: 'integer',
      enum: [1],
    });
  });
});
