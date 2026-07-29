import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalUrl = z
  .string()
  .default('')
  .refine((value) => value === '' || URL.canParse(value), 'Must be empty or a valid URL');

const optionalHttpUrl = z
  .string()
  .default('')
  .refine((value) => {
    if (value === '' || !URL.canParse(value)) return value === '';
    return ['http:', 'https:'].includes(new URL(value).protocol);
  }, 'Must be empty or a valid HTTP(S) URL');

export const aiProviderSchema = z.enum(['openai', 'gemini']);
export type AiProviderName = z.infer<typeof aiProviderSchema>;

const optionalProvider = z.enum(['', 'openai', 'gemini']).default('');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOCAL_UI_ENABLED: booleanString,
    LOCAL_UI_ORIGIN: z.string().url().default('http://localhost:8080'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    ETM_API_SECRET: z.string().min(32),
    ALLOWED_CIDRS: z.string().default('127.0.0.1/32,::1/128'),
    CADDY_TRUSTED_PROXIES: z.string().default('172.16.0.0/12'),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    RATE_LIMIT_WINDOW: z.string().default('1 minute'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    TRANSCRIPTION_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
    JOB_DATA_ROOT: z.string().default('/data/jobs'),
    MIN_FREE_DISK_BYTES: z.coerce.number().int().nonnegative().default(1_073_741_824),
    MAX_VIDEO_DURATION_SECONDS: z.coerce.number().int().positive().default(14_400),
    ALLOWED_YOUTUBE_CHANNEL_IDS: z.string().default(''),
    YOUTUBE_COOKIES_PATH: z.string().default('/run/secrets/youtube_cookies'),
    YOUTUBE_PO_TOKEN_PROVIDER_URL: optionalHttpUrl,
    YTDLP_METADATA_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    YTDLP_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(7_200_000),
    FFMPEG_TIMEOUT_MS: z.coerce.number().int().positive().default(7_200_000),
    AUDIO_CHUNK_SECONDS: z.coerce.number().int().min(60).default(600),
    AUDIO_CHUNK_OVERLAP_SECONDS: z.coerce.number().int().min(0).max(30).default(3),
    AI_PROVIDER: aiProviderSchema.default('openai'),
    TRANSCRIPTION_PROVIDER: optionalProvider,
    ANALYSIS_PROVIDER: optionalProvider,
    VISUAL_PROVIDER: optionalProvider,
    OPENAI_API_KEY: z.string().default(''),
    OPENAI_TRANSCRIPTION_MODEL: z.string().default('whisper-1'),
    OPENAI_ANALYSIS_MODEL: z.string().default('gpt-5.6-sol'),
    OPENAI_VISUAL_MODEL: z.string().default('gpt-5.6-sol'),
    OPENAI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    GEMINI_API_KEY: z.string().default(''),
    GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),
    GEMINI_TRANSCRIPTION_MODEL: z.string().default('gemini-3.6-flash'),
    GEMINI_ANALYSIS_MODEL: z.string().default('gemini-3.6-flash'),
    GEMINI_VISUAL_MODEL: z.string().default('gemini-3.6-flash'),
    GEMINI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    ENABLE_VISUAL_ANALYSIS: booleanString,
    MAX_ANALYSIS_FRAMES: z.coerce.number().int().min(1).max(200).default(40),
    MAX_ANALYSIS_JSON_CHARACTERS: z.coerce.number().int().positive().default(95_000),
    MAX_BATCH_VIDEOS: z.coerce.number().int().min(1).max(50).default(10),
    MAX_BATCH_JSON_BYTES: z.coerce.number().int().positive().default(5_000_000),
    N8N_CALLBACK_URL: optionalUrl,
    N8N_CALLBACK_SECRET: z.string().default(''),
    CALLBACK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(12).default(6),
  })
  .superRefine((config, context) => {
    const providers = resolveAiProviders(config);
    if (Object.values(providers).includes('openai') && !config.OPENAI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'Required when any AI stage uses OpenAI',
      });
    }
    if (Object.values(providers).includes('gemini') && !config.GEMINI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GEMINI_API_KEY'],
        message: 'Required when any AI stage uses Gemini',
      });
    }
    if (providers.transcription === 'openai' && config.OPENAI_TRANSCRIPTION_MODEL !== 'whisper-1') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_TRANSCRIPTION_MODEL'],
        message: 'Must be whisper-1 because timestamped verbose_json transcription is required',
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(environment);
}

export function resolveAiProviders(config: {
  AI_PROVIDER: AiProviderName;
  TRANSCRIPTION_PROVIDER: '' | AiProviderName;
  ANALYSIS_PROVIDER: '' | AiProviderName;
  VISUAL_PROVIDER: '' | AiProviderName;
}): {
  transcription: AiProviderName;
  analysis: AiProviderName;
  visual: AiProviderName;
} {
  return {
    transcription: config.TRANSCRIPTION_PROVIDER || config.AI_PROVIDER,
    analysis: config.ANALYSIS_PROVIDER || config.AI_PROVIDER,
    visual: config.VISUAL_PROVIDER || config.AI_PROVIDER,
  };
}

export function csv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
