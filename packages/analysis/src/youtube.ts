import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { videoIdSchema } from '../../shared/src/index.js';
import { classifyYoutubeError, PipelineError } from './errors.js';
import { runProcess } from './process.js';

const metadataSchema = z
  .object({
    id: videoIdSchema,
    title: z.string(),
    duration: z.number().nonnegative(),
    channel_id: z.string().nullable().optional(),
    live_status: z.string().nullable().optional(),
    is_live: z.boolean().optional(),
    was_live: z.boolean().optional(),
    _type: z.string().optional(),
    entries: z.unknown().optional(),
  })
  .passthrough();

export type YoutubeMetadata = z.infer<typeof metadataSchema>;

export interface YoutubeOptions {
  cookiesPath: string;
  poTokenProviderUrl?: string;
  metadataTimeoutMs: number;
  downloadTimeoutMs: number;
  maxDurationSeconds: number;
  allowedChannelIds: string[];
}

export function youtubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoIdSchema.parse(videoId)}`;
}

export function poTokenArgs(providerUrl?: string): string[] {
  const normalizedUrl = providerUrl?.trim().replace(/\/+$/, '');
  if (!normalizedUrl) return [];
  return [
    '--extractor-args',
    'youtube:player_client=mweb',
    '--extractor-args',
    `youtubepot-bgutilhttp:base_url=${normalizedUrl}`,
  ];
}

export function metadataArgs(
  videoId: string,
  cookiesAvailable: boolean,
  poTokenProviderUrl?: string,
): string[] {
  return [
    '--no-playlist',
    '--skip-download',
    '--dump-single-json',
    '--no-warnings',
    '--js-runtimes',
    'node',
    ...poTokenArgs(poTokenProviderUrl),
    ...(cookiesAvailable ? ['--cookies', '/run/secrets/youtube_cookies'] : []),
    '--',
    youtubeUrl(videoId),
  ];
}

export function downloadArgs(input: {
  videoId: string;
  outputTemplate: string;
  includeVideo: boolean;
  cookiesPath?: string;
  poTokenProviderUrl?: string;
  playerClient?: 'mweb' | 'web_embedded';
}): string[] {
  const format = input.includeVideo
    ? 'bv*[height<=1080]+ba/b[height<=1080]/best'
    : 'bestaudio/best';
  const clientArgs =
    input.playerClient === 'web_embedded'
      ? ['--extractor-args', 'youtube:player_client=web_embedded']
      : poTokenArgs(input.poTokenProviderUrl);
  return [
    '--no-playlist',
    '--no-progress',
    '--newline',
    '--js-runtimes',
    'node',
    ...clientArgs,
    '--format',
    format,
    '--output',
    input.outputTemplate,
    '--print',
    'after_move:filepath',
    ...(input.cookiesPath ? ['--cookies', input.cookiesPath] : []),
    '--',
    youtubeUrl(input.videoId),
  ];
}

export function validateMetadata(
  raw: unknown,
  expectedVideoId: string,
  maxDurationSeconds: number,
  allowedChannelIds: string[],
): YoutubeMetadata {
  const metadata = metadataSchema.parse(raw);
  if (metadata.id !== expectedVideoId) {
    throw new PipelineError('VIDEO_NOT_AUTHORIZED', 'YouTube returned a different video', false);
  }
  if (metadata._type === 'playlist' || metadata.entries !== undefined) {
    throw new PipelineError('VIDEO_NOT_AUTHORIZED', 'Playlists are not accepted', false);
  }
  if (
    metadata.is_live ||
    metadata.live_status === 'is_live' ||
    metadata.live_status === 'is_upcoming'
  ) {
    throw new PipelineError(
      'VIDEO_NOT_AUTHORIZED',
      'Unfinished livestreams are not accepted',
      false,
    );
  }
  if (metadata.duration > maxDurationSeconds) {
    throw new PipelineError('VIDEO_TOO_LONG', 'The video exceeds the duration limit', false);
  }
  if (
    allowedChannelIds.length > 0 &&
    (!metadata.channel_id || !allowedChannelIds.includes(metadata.channel_id))
  ) {
    throw new PipelineError('UNEXPECTED_CHANNEL', 'The video channel is not authorized', false);
  }
  return metadata;
}

export class YoutubeClient {
  constructor(
    private readonly options: YoutubeOptions,
    private readonly processRunner: typeof runProcess = runProcess,
  ) {}

  async getMetadata(videoId: string): Promise<YoutubeMetadata> {
    const hasCookies = await cookiesAvailable(this.options.cookiesPath);
    const args = metadataArgs(videoId, hasCookies, this.options.poTokenProviderUrl).map((value) =>
      value === '/run/secrets/youtube_cookies' ? this.options.cookiesPath : value,
    );
    try {
      const result = await this.processRunner('yt-dlp', args, {
        timeoutMs: this.options.metadataTimeoutMs,
      });
      return validateMetadata(
        JSON.parse(result.stdout) as unknown,
        videoId,
        this.options.maxDurationSeconds,
        this.options.allowedChannelIds,
      );
    } catch (error) {
      if (error instanceof PipelineError || error instanceof z.ZodError) throw error;
      throw classifyYoutubeError(error instanceof Error ? error.message : String(error));
    }
  }

  async download(videoId: string, directory: string, includeVideo: boolean): Promise<string> {
    const hasCookies = await cookiesAvailable(this.options.cookiesPath);
    const outputTemplate = join(directory, includeVideo ? 'source.%(ext)s' : 'audio.%(ext)s');
    const args = downloadArgs({
      videoId,
      outputTemplate,
      includeVideo,
      ...(this.options.poTokenProviderUrl
        ? { poTokenProviderUrl: this.options.poTokenProviderUrl }
        : {}),
      ...(hasCookies ? { cookiesPath: this.options.cookiesPath } : {}),
    });
    try {
      const { stdout } = await this.processRunner('yt-dlp', args, {
        timeoutMs: this.options.downloadTimeoutMs,
      });
      const path = stdout.trim().split(/\r?\n/).at(-1);
      if (!path) throw new Error('yt-dlp did not report a downloaded path');
      return path;
    } catch (error) {
      const primaryMessage = error instanceof Error ? error.message : String(error);
      if (!isYoutubeHttp403(primaryMessage)) throw classifyYoutubeError(primaryMessage);

      const fallbackArgs = downloadArgs({
        videoId,
        outputTemplate,
        includeVideo,
        playerClient: 'web_embedded',
        ...(hasCookies ? { cookiesPath: this.options.cookiesPath } : {}),
      });
      let fallbackStdout: string;
      try {
        const { stdout } = await this.processRunner('yt-dlp', fallbackArgs, {
          timeoutMs: this.options.downloadTimeoutMs,
        });
        fallbackStdout = stdout;
      } catch (fallbackError) {
        const classified = classifyYoutubeError(
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        );
        throw new PipelineError(classified.code, classified.message, classified.retryable, {
          cause: fallbackError,
        });
      }
      const path = fallbackStdout.trim().split(/\r?\n/).at(-1);
      if (!path) {
        throw new PipelineError(
          'DOWNLOAD_FAILED',
          'yt-dlp did not report a downloaded path',
          true,
          { cause: error },
        );
      }
      return path;
    }
  }
}

export function isYoutubeHttp403(message: string): boolean {
  return /(?:http error\s+403|403:\s*forbidden)/i.test(message);
}

export async function cookiesAvailable(path: string): Promise<boolean> {
  try {
    const contents = await readFile(path, 'utf8');
    return /^(?:# Netscape HTTP Cookie File|# HTTP Cookie File)\r?$/m.test(
      contents.replace(/^\uFEFF/, ''),
    );
  } catch {
    return false;
  }
}
