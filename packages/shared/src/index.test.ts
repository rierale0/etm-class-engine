import { describe, expect, it } from 'vitest';
import { validAnalysis } from '../../../tests/fixtures/analysis.js';
import { analysisSchema, videoIdSchema, youtubeVideoId } from './index.js';

describe('shared schemas', () => {
  it('validates only eleven-character YouTube IDs', () => {
    expect(videoIdSchema.safeParse('DEMOclass01').success).toBe(true);
    expect(videoIdSchema.safeParse('https://youtube.com').success).toBe(false);
    expect(videoIdSchema.safeParse('short').success).toBe(false);
  });

  it('extracts IDs from supported YouTube URL forms', () => {
    expect(youtubeVideoId('DEMOclass01')).toBe('DEMOclass01');
    expect(youtubeVideoId('https://youtu.be/DEMOclass01?t=20')).toBe('DEMOclass01');
    expect(youtubeVideoId('https://www.youtube.com/watch?v=DEMOclass01')).toBe('DEMOclass01');
    expect(youtubeVideoId('https://youtube.com/shorts/DEMOclass01')).toBe('DEMOclass01');
    expect(youtubeVideoId('https://example.com/DEMOclass01')).toBeNull();
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
