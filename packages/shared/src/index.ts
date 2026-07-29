import { z } from 'zod';

export const videoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);

export function youtubeVideoId(input: string): string {
  const value = input.trim();
  if (videoIdSchema.safeParse(value).success) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('A valid YouTube URL is required');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('A valid YouTube URL is required');
  }

  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  let candidate: string | null = null;
  if (hostname === 'youtu.be') {
    candidate = url.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (
    hostname === 'youtube.com' ||
    hostname === 'm.youtube.com' ||
    hostname === 'music.youtube.com' ||
    hostname === 'youtube-nocookie.com'
  ) {
    if (url.pathname === '/watch') {
      candidate = url.searchParams.get('v');
    } else {
      const [kind, id] = url.pathname.split('/').filter(Boolean);
      if (['embed', 'live', 'shorts'].includes(kind ?? '')) candidate = id ?? null;
    }
  }

  const parsed = videoIdSchema.safeParse(candidate);
  if (!parsed.success) throw new Error('A valid YouTube video URL is required');
  return parsed.data;
}

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

const batchClassSchema = z
  .object({
    job_id: z.string().uuid(),
    video_url: z.string().url(),
    submission: z
      .object({
        title: nonEmpty,
        class_date: z.string().date(),
        teacher: nonEmpty,
        course: nonEmpty,
        analyze_visuals: z.boolean(),
      })
      .strict(),
    analysis: analysisSchema,
  })
  .strict();

export const batchResultSchema = z
  .object({
    schema_version: z.literal(1),
    batch: z
      .object({
        id: z.string().uuid(),
        name: nonEmpty,
        status: z.literal('ready'),
        class_count: z.number().int().positive(),
        created_at: z.string().datetime(),
        completed_at: z.string().datetime(),
      })
      .strict(),
    order: z.array(videoIdSchema),
    classes: z.record(videoIdSchema, batchClassSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.order.length !== value.batch.class_count) {
      context.addIssue({ code: 'custom', message: 'Batch class count does not match order' });
    }
    if (new Set(value.order).size !== value.order.length) {
      context.addIssue({ code: 'custom', message: 'Batch order contains duplicate video IDs' });
    }
    if (Object.keys(value.classes).length !== value.order.length) {
      context.addIssue({ code: 'custom', message: 'Batch classes do not match order' });
    }
    for (const videoId of value.order) {
      if (!(videoId in value.classes)) {
        context.addIssue({ code: 'custom', message: `Batch class ${videoId} is missing` });
      }
    }
  });

export type BatchResult = z.infer<typeof batchResultSchema>;

export interface BatchAssemblyJob {
  id: string;
  videoId: string;
  requestPayload: unknown;
  resultJson?: unknown;
  status: string;
  completedAt: Date | null;
}

export interface BatchAssemblyInput {
  id: string;
  name: string;
  createdAt: Date;
  jobs: BatchAssemblyJob[];
}

export function assembleBatchResult(input: BatchAssemblyInput): BatchResult {
  if (input.jobs.length === 0) throw new Error('A batch must contain at least one class');
  const order: string[] = [];
  const classes: Record<string, z.infer<typeof batchClassSchema>> = {};
  let completedAt = 0;

  for (const job of input.jobs) {
    if (job.status !== 'completed' || job.resultJson === null) {
      throw new Error('Every class must be completed before assembling the batch');
    }
    if (classes[job.videoId]) throw new Error('A batch cannot contain duplicate video IDs');
    const request = analyzeRequestSchema.parse(job.requestPayload);
    const analysis = analysisSchema.parse(job.resultJson);
    if (!job.completedAt) throw new Error('A completed class must have a completion timestamp');
    completedAt = Math.max(completedAt, job.completedAt.getTime());
    order.push(job.videoId);
    classes[job.videoId] = {
      job_id: job.id,
      video_url: `https://www.youtube.com/watch?v=${job.videoId}`,
      submission: {
        title: request.title,
        class_date: request.classDate,
        teacher: request.teacher,
        course: request.course,
        analyze_visuals: request.analyzeVisuals,
      },
      analysis,
    };
  }

  return batchResultSchema.parse({
    schema_version: 1,
    batch: {
      id: input.id,
      name: input.name,
      status: 'ready',
      class_count: input.jobs.length,
      created_at: input.createdAt.toISOString(),
      completed_at: new Date(completedAt).toISOString(),
    },
    order,
    classes,
  });
}

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
