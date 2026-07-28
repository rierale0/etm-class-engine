import { z } from 'zod';

export const videoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);

export const analyzeRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    classDate: z.string().date(),
    teacher: z.string().trim().min(1).max(200),
    course: z.string().trim().min(1).max(200),
    analyzeVisuals: z.boolean().default(false),
  })
  .strict();

export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;

export const jobStatuses = [
  'queued',
  'validating_video',
  'downloading',
  'extracting_audio',
  'transcribing',
  'extracting_frames',
  'analyzing_visuals',
  'synthesizing',
  'sending_callback',
  'completed',
  'failed',
] as const;

export const jobStatusSchema = z.enum(jobStatuses);
export type JobStatus = z.infer<typeof jobStatusSchema>;

const timestamp = z.string().regex(/^\d{2,}:\d{2}:\d{2}$/);
const nonEmpty = z.string().min(1);

const metadataSchema = z
  .object({
    video_id: nonEmpty,
    video_url: z.string().url(),
    title: nonEmpty,
    class_date: z.string().date(),
    teacher: nonEmpty,
    course: nonEmpty,
    duration_seconds: z.number().nonnegative(),
    processed_at: z.string().datetime(),
    transcription_model: nonEmpty,
    analysis_model: nonEmpty,
    visual_analysis_enabled: z.boolean(),
  })
  .strict();

const sectionSchema = z
  .object({
    start: timestamp,
    end: timestamp,
    title: nonEmpty,
    summary: nonEmpty,
    visual_context: z.string(),
  })
  .strict();

export const analysisSchema = z
  .object({
    schema_version: z.literal(1),
    metadata: metadataSchema,
    language: nonEmpty,
    estimated_level: nonEmpty,
    summary: nonEmpty,
    learning_objectives: z.array(nonEmpty),
    sections: z.array(sectionSchema),
    key_concepts: z.array(
      z
        .object({
          concept: nonEmpty,
          explanation: nonEmpty,
          examples: z.array(nonEmpty),
        })
        .strict(),
    ),
    vocabulary: z.array(
      z
        .object({
          term: nonEmpty,
          meaning: nonEmpty,
          example: z.string(),
          timestamp,
        })
        .strict(),
    ),
    grammar: z.array(
      z
        .object({
          topic: nonEmpty,
          explanation: nonEmpty,
          examples: z.array(nonEmpty),
          timestamp,
        })
        .strict(),
    ),
    pronunciation: z.array(z.object({ item: nonEmpty, guidance: nonEmpty, timestamp }).strict()),
    teacher_corrections: z.array(
      z
        .object({
          original: nonEmpty,
          correction: nonEmpty,
          explanation: nonEmpty,
          timestamp,
        })
        .strict(),
    ),
    student_difficulties: z.array(nonEmpty),
    visual_materials: z.array(
      z
        .object({
          timestamp,
          description: nonEmpty,
          relevance: nonEmpty,
        })
        .strict(),
    ),
    suggested_exercises: z.array(
      z.object({ instruction: nonEmpty, answer_or_key: nonEmpty }).strict(),
    ),
    next_steps: z.array(nonEmpty),
    transcript: z.string(),
    processing_warning: z.string().nullable(),
  })
  .strict();

export type ClassAnalysis = z.infer<typeof analysisSchema>;

export interface TranscriptSegment {
  start: string;
  end: string;
  speaker: string | null;
  text: string;
}

export interface VisualObservation {
  timestamp: string;
  description: string;
  relevance: string;
}

export interface ProcessingWarning {
  code: string;
  message: string;
  chunkIndex?: number;
}

export const queueName = 'class-analysis';
