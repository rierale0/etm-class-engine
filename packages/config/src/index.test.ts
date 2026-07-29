import { describe, expect, it } from 'vitest';
import { loadConfig, resolveAiProviders } from './index.js';

const baseEnvironment = {
  DATABASE_URL: 'postgresql://etm:test@localhost:5432/etm',
  REDIS_URL: 'redis://localhost:6379',
  ETM_API_SECRET: 'a'.repeat(32),
};

describe('AI provider configuration', () => {
  it('uses OpenAI for every stage by default', () => {
    const config = loadConfig({ ...baseEnvironment, OPENAI_API_KEY: 'openai-key' });
    expect(config.OPENAI_TRANSCRIPTION_MODEL).toBe('whisper-1');
    expect(resolveAiProviders(config)).toEqual({
      transcription: 'openai',
      analysis: 'openai',
      visual: 'openai',
    });
  });

  it('accepts an internal HTTP PO Token provider and rejects non-HTTP schemes', () => {
    expect(
      loadConfig({
        ...baseEnvironment,
        OPENAI_API_KEY: 'openai-key',
        YOUTUBE_PO_TOKEN_PROVIDER_URL: 'http://pot-provider:4416',
      }).YOUTUBE_PO_TOKEN_PROVIDER_URL,
    ).toBe('http://pot-provider:4416');
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        OPENAI_API_KEY: 'openai-key',
        YOUTUBE_PO_TOKEN_PROVIDER_URL: 'file:///run/secrets/provider',
      }),
    ).toThrow(/HTTP/);
  });

  it('rejects OpenAI transcription models that cannot return segment timestamps', () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        OPENAI_API_KEY: 'openai-key',
        OPENAI_TRANSCRIPTION_MODEL: 'gpt-4o-transcribe',
      }),
    ).toThrow(/whisper-1/);
  });

  it('accepts a Gemini-only deployment without an OpenAI key', () => {
    const config = loadConfig({
      ...baseEnvironment,
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'gemini-key',
    });
    expect(config.OPENAI_API_KEY).toBe('');
    expect(resolveAiProviders(config)).toEqual({
      transcription: 'gemini',
      analysis: 'gemini',
      visual: 'gemini',
    });
  });

  it('supports mixed providers and requires both selected credentials', () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        AI_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'gemini-key',
        TRANSCRIPTION_PROVIDER: 'openai',
      }),
    ).toThrow(/OPENAI_API_KEY/);

    const config = loadConfig({
      ...baseEnvironment,
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'gemini-key',
      OPENAI_API_KEY: 'openai-key',
      TRANSCRIPTION_PROVIDER: 'openai',
    });
    expect(resolveAiProviders(config)).toEqual({
      transcription: 'openai',
      analysis: 'gemini',
      visual: 'gemini',
    });
  });
});
