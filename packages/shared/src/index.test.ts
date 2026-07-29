import { describe, expect, it } from 'vitest';
import { validAnalysis } from '../../../tests/fixtures/analysis.js';
import { analysisSchema, videoIdSchema, youtubeVideoId } from './index.js';

describe('shared schemas', () => {
  it('validates only eleven-character YouTube IDs', () => {
    expect(videoIdSchema.safeParse('DEMOclass01').success).toBe(true);
    expect(videoIdSchema.safeParse('https://youtube.com').success).toBe(false);
    expect(videoIdSchema.safeParse('short').success).toBe(false);
  });

  it('extracts video ids only from supported YouTube URLs', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=U_t4DLT7eVQ')).toBe('U_t4DLT7eVQ');
    expect(youtubeVideoId('https://youtu.be/U_t4DLT7eVQ')).toBe('U_t4DLT7eVQ');
    expect(youtubeVideoId('https://youtube.com/shorts/U_t4DLT7eVQ')).toBe('U_t4DLT7eVQ');
    expect(() => youtubeVideoId('https://example.com/watch?v=U_t4DLT7eVQ')).toThrow();
    expect(() => youtubeVideoId('https://youtube.com/playlist?list=abc')).toThrow();
  });

  it('enforces a strict analysis schema at every object level', () => {
    expect(analysisSchema.parse(validAnalysis()).schema_version).toBe(1);
    expect(analysisSchema.safeParse({ ...validAnalysis(), unexpected: true }).success).toBe(false);
    expect(
      analysisSchema.safeParse({
        ...validAnalysis(),
        metadata: { ...validAnalysis().metadata, unexpected: true },
      }).success,
    ).toBe(false);
  });

  it('detects the configured character limit without truncating JSON', () => {
    const analysis = validAnalysis('x'.repeat(95_000));
    const serialized = JSON.stringify(analysis);
    expect(serialized.length).toBeGreaterThan(95_000);
    expect(analysis.transcript).toHaveLength(95_000);
  });
});
