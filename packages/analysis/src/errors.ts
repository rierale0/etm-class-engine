export const errorCodes = [
  'VIDEO_NOT_FOUND',
  'VIDEO_NOT_AUTHORIZED',
  'YOUTUBE_LOGIN_REQUIRED',
  'YOUTUBE_RATE_LIMITED',
  'VIDEO_TOO_LONG',
  'UNEXPECTED_CHANNEL',
  'DOWNLOAD_FAILED',
  'TRANSCRIPTION_FAILED',
  'ANALYSIS_FAILED',
  'STRUCTURED_OUTPUT_INVALID',
  'INSUFFICIENT_DISK_SPACE',
  'JOB_CANCELLED',
  'CALLBACK_FAILED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export class PipelineError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PipelineError';
  }
}

export function sanitizedError(error: unknown): PipelineError {
  if (error instanceof PipelineError) return error;
  return new PipelineError('INTERNAL_ERROR', 'An internal processing error occurred', true, {
    cause: error,
  });
}

export function classifyYoutubeError(stderr: string): PipelineError {
  const value = stderr.toLowerCase();
  if (value.includes('video unavailable') || value.includes('not available')) {
    return new PipelineError('VIDEO_NOT_FOUND', 'The requested video was not found', false);
  }
  if (
    value.includes('does not look like a netscape format cookies file') ||
    value.includes('invalid cookies file')
  ) {
    return new PipelineError('DOWNLOAD_FAILED', 'The YouTube cookie file is invalid', false);
  }
  if (
    value.includes('sign in to confirm') ||
    value.includes('login required') ||
    value.includes('authentication required') ||
    value.includes('cookies are needed')
  ) {
    return new PipelineError(
      'YOUTUBE_LOGIN_REQUIRED',
      'YouTube authentication is required for this video',
      false,
    );
  }
  if (value.includes('429') || value.includes('too many requests')) {
    return new PipelineError(
      'YOUTUBE_RATE_LIMITED',
      'YouTube temporarily rate limited the request',
      true,
    );
  }
  if (value.includes('private video') || value.includes('members-only')) {
    return new PipelineError('VIDEO_NOT_AUTHORIZED', 'The video is not authorized', false);
  }
  return new PipelineError('DOWNLOAD_FAILED', 'YouTube media retrieval failed', true);
}
