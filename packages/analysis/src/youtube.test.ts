import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyYoutubeError, PipelineError } from './errors.js';
import {
  cookiesAvailable,
  downloadArgs,
  isYoutubeHttp403,
  metadataArgs,
  poTokenArgs,
  YoutubeClient,
  validateMetadata,
} from './youtube.js';
import type { runProcess } from './process.js';

describe('YouTube validation', () => {
  const metadata = {
    id: 'DEMOclass01',
    title: 'Class',
    duration: 1_200,
    channel_id: 'UC-ETM',
    live_status: 'not_live',
  };

  it('accepts the requested authorized single video', () => {
    expect(validateMetadata(metadata, metadata.id, 2_000, ['UC-ETM']).id).toBe(metadata.id);
  });

  it('rejects unexpected channels and long videos with structured codes', () => {
    expect(() => validateMetadata(metadata, metadata.id, 2_000, ['other'])).toThrowError(
      expect.objectContaining<Partial<PipelineError>>({ code: 'UNEXPECTED_CHANNEL' }),
    );
    expect(() => validateMetadata(metadata, metadata.id, 100, [])).toThrowError(
      expect.objectContaining<Partial<PipelineError>>({ code: 'VIDEO_TOO_LONG' }),
    );
  });

  it('constructs argument arrays with a fixed YouTube URL and no shell', () => {
    expect(metadataArgs(metadata.id, false)).toContain(
      `https://www.youtube.com/watch?v=${metadata.id}`,
    );
    const args = downloadArgs({
      videoId: metadata.id,
      outputTemplate: '/data/jobs/id/audio.%(ext)s',
      includeVideo: false,
    });
    expect(args).toContain('bestaudio/best');
    expect(args).not.toContain('sh');
    expect(args.at(-2)).toBe('--');
  });

  it('configures the mweb client and internal bgutil provider without exposing a host port', () => {
    const providerUrl = 'http://pot-provider:4416/';
    expect(poTokenArgs(providerUrl)).toEqual([
      '--extractor-args',
      'youtube:player_client=mweb',
      '--extractor-args',
      'youtubepot-bgutilhttp:base_url=http://pot-provider:4416',
    ]);
    expect(metadataArgs(metadata.id, false, providerUrl)).toEqual(
      expect.arrayContaining(poTokenArgs(providerUrl)),
    );
    expect(
      downloadArgs({
        videoId: metadata.id,
        outputTemplate: '/data/jobs/id/source.%(ext)s',
        includeVideo: true,
        poTokenProviderUrl: providerUrl,
      }),
    ).toEqual(expect.arrayContaining(poTokenArgs(providerUrl)));
    expect(poTokenArgs('')).toEqual([]);
  });

  it('ignores placeholder cookie files and accepts Netscape exports', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etm-youtube-cookies-'));
    const path = join(directory, 'cookies.txt');
    await writeFile(path, '\n');
    await expect(cookiesAvailable(path)).resolves.toBe(false);

    await writeFile(
      path,
      '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret\n',
    );
    await expect(cookiesAvailable(path)).resolves.toBe(true);
  });

  it('does not misclassify a malformed cookie file as a YouTube login requirement', () => {
    expect(
      classifyYoutubeError(
        "ERROR: '/run/secrets/youtube_cookies' does not look like a Netscape format cookies file",
      ),
    ).toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: 'The YouTube cookie file is invalid',
      retryable: false,
    });
  });

  it('retries HTTP 403 downloads with the web embedded client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etm-youtube-fallback-'));
    const cookiesPath = join(directory, 'cookies.txt');
    await writeFile(cookiesPath, '\n');
    const calls: string[][] = [];
    const runner: typeof runProcess = async (_executable, args) => {
      calls.push([...args]);
      if (calls.length === 1) {
        throw new Error('yt-dlp exited with 1: HTTP Error 403: Forbidden');
      }
      return { stdout: `${directory}/audio.webm\n`, stderr: '' };
    };
    const client = new YoutubeClient(
      {
        cookiesPath,
        poTokenProviderUrl: 'http://pot-provider:4416',
        metadataTimeoutMs: 1_000,
        downloadTimeoutMs: 1_000,
        maxDurationSeconds: 10_000,
        allowedChannelIds: [],
      },
      runner,
    );

    await expect(client.download(metadata.id, directory, false)).resolves.toBe(
      `${directory}/audio.webm`,
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.arrayContaining(poTokenArgs('http://pot-provider:4416')));
    expect(calls[1]).toEqual(
      expect.arrayContaining(['--extractor-args', 'youtube:player_client=web_embedded']),
    );
    expect(calls[1]).not.toContain('youtubepot-bgutilhttp:base_url=http://pot-provider:4416');
  });

  it('surfaces HTTP 403 download failures explicitly', () => {
    expect(isYoutubeHttp403('unable to download video data: HTTP Error 403: Forbidden')).toBe(true);
    expect(classifyYoutubeError('HTTP Error 403: Forbidden')).toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: 'YouTube rejected the media transfer (HTTP 403)',
      retryable: true,
    });
  });
});
