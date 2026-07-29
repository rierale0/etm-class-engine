import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyYoutubeError, PipelineError } from './errors.js';
import {
  cookiesAvailable,
  downloadArgs,
  metadataArgs,
  poTokenArgs,
  validateMetadata,
} from './youtube.js';

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
});
