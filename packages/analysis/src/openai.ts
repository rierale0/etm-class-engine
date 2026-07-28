import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import OpenAI from 'openai';
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

const verboseTranscriptionSchema = z
  .object({
    text: z.string(),
    segments: z
      .array(
        z
          .object({
            start: z.number(),
            end: z.number(),
            text: z.string(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

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

export interface OpenAiOptions {
  apiKey: string;
  transcriptionModel: string;
  analysisModel: string;
  visualModel: string;
  timeoutMs: number;
}

export class OpenAiAnalyzer {
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAiOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey, timeout: options.timeoutMs, maxRetries: 5 });
  }

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
      const response = await this.client.audio.transcriptions.create({
        file: createReadStream(path),
        model: this.options.transcriptionModel,
        response_format: 'verbose_json',
        timestamp_granularities: ['segment'],
        prompt: `Preserve English and Spanish exactly. Contextual vocabulary: ${vocabulary}. Previous context: ${previousContext.slice(-1_500)}`,
      });
      const parsed = verboseTranscriptionSchema.parse(response);
      return {
        text: parsed.text,
        segments:
          parsed.segments.length > 0 ? parsed.segments : [{ start: 0, end: 0, text: parsed.text }],
      };
    } catch (error) {
      throw new PipelineError(
        'TRANSCRIPTION_FAILED',
        'A transcription request failed',
        isRetryableOpenAiError(error),
        { cause: error },
      );
    }
  }

  async analyzeFrames(frames: VideoFrame[]): Promise<VisualObservation[]> {
    const output: VisualObservation[] = [];
    for (let index = 0; index < frames.length; index += 8) {
      const batch = frames.slice(index, index + 8);
      const content: OpenAI.Responses.ResponseInputContent[] = [
        {
          type: 'input_text',
          text: 'Report only visible evidence: slides, shared screens, readable vocabulary, grammar examples, exercises, written corrections, and relevant transitions. Do not guess unreadable text, infer speech, invent student actions, or invent lesson content. Return JSON observations with timestamp, description, relevance.',
        },
      ];
      for (const frame of batch) {
        const base64 = (await readFile(frame.path)).toString('base64');
        content.push({
          type: 'input_text',
          text: `Frame timestamp ${formatTimestamp(frame.timestampSeconds)}`,
        });
        content.push({
          type: 'input_image',
          image_url: `data:image/jpeg;base64,${base64}`,
          detail: 'low',
        });
      }
      const response = await this.client.responses.create({
        model: this.options.visualModel,
        store: false,
        reasoning: { effort: 'medium' },
        max_output_tokens: 4_000,
        input: [{ role: 'user', content }],
        text: {
          format: {
            type: 'json_schema',
            name: 'visual_observations',
            strict: true,
            schema: {
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
            },
          },
        },
      });
      output.push(
        ...visualBatchSchema.parse(JSON.parse(response.output_text) as unknown).observations,
      );
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
      const response = await this.client.responses.create({
        model: this.options.analysisModel,
        store: false,
        reasoning: { effort: 'medium' },
        max_output_tokens: 32_000,
        input: [
          {
            role: 'system',
            content:
              'Analyze this English class using only supplied evidence. Never invent names, corrections, student actions, or lesson content. Keep unsupported collections empty. Distinguish transcript and visual evidence. State when timing is approximate. Set the transcript field to an empty string; the application attaches the complete timestamped transcript deterministically. Return only schema-valid JSON without Markdown.',
          },
          { role: 'user', content: JSON.stringify(evidence) },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'etm_class_analysis',
            strict: true,
            schema: classAnalysisJsonSchema,
          },
        },
      });
      if (!response.output_text) {
        throw new Error('The analysis response did not contain output text');
      }
      const parsed = analysisSchema.parse(JSON.parse(response.output_text) as unknown);
      return { ...parsed, transcript: completeTranscript };
    } catch (error) {
      if (error instanceof PipelineError) throw error;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new PipelineError(
          'STRUCTURED_OUTPUT_INVALID',
          'The analysis response failed strict schema validation',
          true,
          { cause: error },
        );
      }
      throw new PipelineError(
        'ANALYSIS_FAILED',
        'The final class analysis failed',
        isRetryableOpenAiError(error),
        { cause: error },
      );
    }
  }
}

function isRetryableOpenAiError(error: unknown): boolean {
  if (error instanceof OpenAI.APIError) {
    return (
      error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500
    );
  }
  return true;
}
