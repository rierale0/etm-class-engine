import { describe, expect, it } from 'vitest';
import { validAnalysis } from '../../../tests/fixtures/analysis.js';
import { analysisSchema, assembleBatchResult, videoIdSchema, youtubeVideoId } from './index.js';

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

  it('assembles one or more analyses without changing their contents', () => {
    const first = validAnalysis('First transcript');
    const second = validAnalysis('Second transcript');
    const result = assembleBatchResult({
      id: '6db014a1-f5ab-47d0-82c3-84e514f5db3d',
      name: 'Thursday classes',
      createdAt: new Date('2026-07-16T18:00:00.000Z'),
      jobs: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          videoId: 'U_t4DLT7eVQ',
          requestPayload: {
            title: 'Class 1',
            classDate: '2026-07-16',
            teacher: 'Sebastián Mesías',
            course: 'English Usage',
            analyzeVisuals: true,
          },
          resultJson: first,
          status: 'completed',
          completedAt: new Date('2026-07-16T19:00:00.000Z'),
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          videoId: 'zXys9XxWvhg',
          requestPayload: {
            title: 'Class 2',
            classDate: '2026-07-16',
            teacher: 'Sebastián Mesías',
            course: 'English Usage',
            analyzeVisuals: true,
          },
          resultJson: second,
          status: 'completed',
          completedAt: new Date('2026-07-16T20:00:00.000Z'),
        },
      ],
    });
    expect(result.order).toEqual(['U_t4DLT7eVQ', 'zXys9XxWvhg']);
    expect(result.classes.U_t4DLT7eVQ?.analysis).toEqual(first);
    expect(result.classes.zXys9XxWvhg?.analysis).toEqual(second);
    expect(result.batch.completed_at).toBe('2026-07-16T20:00:00.000Z');
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
