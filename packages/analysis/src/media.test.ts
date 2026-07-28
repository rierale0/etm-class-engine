import { describe, expect, it } from 'vitest';
import { ffmpegAudioArgs, planAudioChunks } from './media.js';
import { deduplicateOverlap, normalizeTranscriptions } from './transcript.js';

describe('audio chunking', () => {
  it('orders chunks and applies offsets with overlap', () => {
    expect(planAudioChunks(1_201, 600, 3)).toEqual([
      { chunkIndex: 0, startSeconds: 0, endSeconds: 600 },
      { chunkIndex: 1, startSeconds: 597, endSeconds: 1197 },
      { chunkIndex: 2, startSeconds: 1194, endSeconds: 1201 },
    ]);
  });

  it('builds an argument array for mono 16 kHz MP3', () => {
    const args = ffmpegAudioArgs('unsafe;name.mp4', {
      chunkIndex: 0,
      startSeconds: 0,
      endSeconds: 600,
      path: 'out.mp3',
    });
    expect(args).toContain('unsafe;name.mp4');
    expect(args).toContain('16000');
    expect(args).not.toContain('sh');
  });
});

describe('transcript normalization', () => {
  it('removes overlap duplication and uses complete-recording timestamps', () => {
    expect(
      deduplicateOverlap('we are learning the knowledge tree', 'the knowledge tree today'),
    ).toBe('today');
    const result = normalizeTranscriptions(
      [
        { chunkIndex: 0, startSeconds: 0, endSeconds: 600, path: '0.mp3' },
        { chunkIndex: 1, startSeconds: 597, endSeconds: 900, path: '1.mp3' },
      ],
      [
        {
          text: 'hello knowledge tree',
          segments: [{ start: 0, end: 2, text: 'hello knowledge tree' }],
        },
        {
          text: 'hello knowledge tree today',
          segments: [{ start: 0, end: 4, text: 'hello knowledge tree today' }],
        },
      ],
    );
    expect(result.segments[1]).toMatchObject({ start: '00:09:57', text: 'today' });
    expect(result.segments.every((segment) => segment.speaker === null)).toBe(true);
  });
});
