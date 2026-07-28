import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  analysisSchema,
  type AnalyzeRequest,
  type ClassAnalysis,
  type ProcessingWarning,
  type TranscriptSegment,
  type VisualObservation,
} from '../../shared/src/index.js';
import { classAnalysisJsonSchema } from '../../shared/src/json-schema.js';
import { PipelineError } from './errors.js';
import type { VideoFrame } from './media.js';
import type { ChunkTranscription } from './transcript.js';
import { formatTimestamp, transcriptAsText } from './transcript.js';
import type { YoutubeMetadata } from './youtube.js';

const transcriptionSchema = z
  .object({
    text: z.string(),
    segments: z.array(
      z
        .object({
          start: z.number().nonnegative(),
          end: z.number().nonnegative(),
          text: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

const transcriptionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'segments'],
  properties: {
    text: { type: 'string' },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'text'],
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          text: { type: 'string' },
        },
      },
    },
  },
} as const;

const visualBatchSchema = z
  .object({
    observations: z.array(
      z
        .object({
          timestamp: z.string(),
          description: z.string(),
          relevance: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

const visualBatchJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['observations'],
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['timestamp', 'description', 'relevance'],
        properties: {
          timestamp: { type: 'string' },
          description: { type: 'string' },
          relevance: { type: 'string' },
        },
      },
    },
  },
} as const;

const responseSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            content: z
              .object({
                parts: z.array(z.object({ text: z.string().optional() }).passthrough()).default([]),
              })
              .passthrough()
              .optional(),
            finishReason: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export interface GeminiOptions {
  apiKey: string;
  baseUrl: string;
  transcriptionModel: string;
  analysisModel: string;
  visualModel: string;
  timeoutMs: number;
}

export class GeminiAnalyzer {
  constructor(
    private readonly options: GeminiOptions,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async transcribeChunk(
    path: string,
    teacher: string,
    previousContext: string,
  ): Promise<ChunkTranscription> {
    const vocabulary = [
      'ETM English',
      'English Workshop',
      'Morphing',
      'Knowledge Tree',
      'Reprogramming',
      'English Usage',
      teacher,
    ].join(', ');
    try {
      const audio = (await readFile(path)).toString('base64');
      const output = await this.generate(this.options.transcriptionModel, {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text:
                  'Transcribe this class audio exactly, preserving English and Spanish. Return segment timestamps as seconds relative to the beginning of this audio chunk. Do not translate, summarize, or identify speakers unless explicit names are spoken. ' +
                  `Contextual vocabulary: ${vocabulary}. Previous context: ${previousContext.slice(-1_500)}`,
              },
              { inlineData: { mimeType: 'audio/mpeg', data: audio } },
            ],
          },
        ],
        generationConfig: structuredConfig(transcriptionJsonSchema, 32_000),
      });
      const parsed = transcriptionSchema.parse(JSON.parse(output) as unknown);
      return {
        text: parsed.text,
        segments:
          parsed.segments.length > 0 ? parsed.segments : [{ start: 0, end: 0, text: parsed.text }],
      };
    } catch (error) {
      throw new PipelineError(
        'TRANSCRIPTION_FAILED',
        'A Gemini transcription request failed',
        isRetryableGeminiError(error),
        { cause: error },
      );
    }
  }

  async analyzeFrames(frames: VideoFrame[]): Promise<VisualObservation[]> {
    const output: VisualObservation[] = [];
    for (let index = 0; index < frames.length; index += 8) {
      const batch = frames.slice(index, index + 8);
      const parts: Array<Record<string, unknown>> = [
        {
          text: 'Report only visible evidence: slides, shared screens, readable vocabulary, grammar examples, exercises, written corrections, and relevant transitions. Do not guess unreadable text, infer speech, invent student actions, or invent lesson content. Return JSON observations with timestamp, description, and relevance.',
        },
      ];
      for (const frame of batch) {
        parts.push({ text: `Frame timestamp ${formatTimestamp(frame.timestampSeconds)}` });
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: (await readFile(frame.path)).toString('base64'),
          },
        });
      }
      try {
        const response = await this.generate(this.options.visualModel, {
          contents: [{ role: 'user', parts }],
          generationConfig: structuredConfig(visualBatchJsonSchema, 4_000),
        });
        output.push(...visualBatchSchema.parse(JSON.parse(response) as unknown).observations);
      } catch (error) {
        throw new PipelineError(
          'ANALYSIS_FAILED',
          'A Gemini visual analysis request failed',
          isRetryableGeminiError(error),
          { cause: error },
        );
      }
    }
    return output;
  }

  async synthesize(input: {
    videoId: string;
    request: AnalyzeRequest;
    metadata: YoutubeMetadata;
    transcript: TranscriptSegment[];
    visuals: VisualObservation[];
    warnings: ProcessingWarning[];
    visualAnalysisEnabled: boolean;
  }): Promise<ClassAnalysis> {
    const completeTranscript = transcriptAsText(input.transcript);
    const evidence = {
      request_metadata: input.request,
      youtube_metadata: {
        video_id: input.videoId,
        duration_seconds: input.metadata.duration,
      },
      transcript: completeTranscript,
      visual_observations: input.visuals,
      processing_warnings: input.warnings,
      required_metadata: {
        video_url: `https://www.youtube.com/watch?v=${input.videoId}`,
        processed_at: new Date().toISOString(),
        transcription_model: this.options.transcriptionModel,
        analysis_model: this.options.analysisModel,
        visual_analysis_enabled: input.visualAnalysisEnabled,
      },
    };
    try {
      const response = await this.generate(this.options.analysisModel, {
        systemInstruction: {
          parts: [
            {
              text: 'Analyze this English class using only supplied evidence. Never invent names, corrections, student actions, or lesson content. Keep unsupported collections empty. Distinguish transcript and visual evidence. State when timing is approximate. Set the transcript field to an empty string; the application attaches the complete timestamped transcript deterministically. Return only schema-valid JSON without Markdown.',
            },
          ],
        },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(evidence) }] }],
        generationConfig: structuredConfig(toGeminiJsonSchema(classAnalysisJsonSchema), 60_000),
      });
      const parsed = analysisSchema.parse(JSON.parse(response) as unknown);
      return { ...parsed, transcript: completeTranscript };
    } catch (error) {
      if (error instanceof PipelineError) throw error;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new PipelineError(
          'STRUCTURED_OUTPUT_INVALID',
          'The Gemini analysis response failed strict schema validation',
          true,
          { cause: error },
        );
      }
      throw new PipelineError(
        'ANALYSIS_FAILED',
        'The final Gemini class analysis failed',
        isRetryableGeminiError(error),
        { cause: error },
      );
    }
  }

  private async generate(model: string, body: Record<string, unknown>): Promise<string> {
    const baseUrl = this.options.baseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await this.fetchImplementation(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': this.options.apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        if (!response.ok) {
          throw new GeminiHttpError(response.status, response.statusText);
        }
        const parsed = responseSchema.parse(await response.json());
        const text = parsed.candidates[0]?.content?.parts
          .map((part) => part.text ?? '')
          .join('')
          .trim();
        if (!text) {
          const finishReason = parsed.candidates[0]?.finishReason ?? 'no candidate';
          throw new Error(`Gemini response contained no text (${finishReason})`);
        }
        return text;
      } catch (error) {
        lastError = error;
        if (!isRetryableGeminiError(error) || attempt === 4) throw error;
        await delay(Math.min(4_000, 250 * 2 ** attempt));
      }
    }
    throw lastError;
  }
}

class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
  ) {
    super(`Gemini API returned HTTP ${String(status)}${statusText ? ` ${statusText}` : ''}`);
  }
}

function structuredConfig(schema: unknown, maximumTokens: number): Record<string, unknown> {
  return {
    temperature: 0.1,
    maxOutputTokens: maximumTokens,
    responseMimeType: 'application/json',
    responseJsonSchema: schema,
  };
}

function toGeminiJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => toGeminiJsonSchema(item));
  if (!value || typeof value !== 'object') return value;
  const converted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'const') {
      converted.enum = [child];
    } else {
      converted[key] = toGeminiJsonSchema(child);
    }
  }
  return converted;
}

function isRetryableGeminiError(error: unknown): boolean {
  if (error instanceof GeminiHttpError) {
    return (
      error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500
    );
  }
  return !(error instanceof z.ZodError || error instanceof SyntaxError);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
