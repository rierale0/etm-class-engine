import type { AiPort } from './pipeline.js';

export class AiRouter implements AiPort {
  constructor(
    private readonly transcriptionProvider: AiPort,
    private readonly analysisProvider: AiPort,
    private readonly visualProvider: AiPort,
  ) {}

  transcribeChunk(
    ...parameters: Parameters<AiPort['transcribeChunk']>
  ): ReturnType<AiPort['transcribeChunk']> {
    return this.transcriptionProvider.transcribeChunk(...parameters);
  }

  analyzeFrames(
    ...parameters: Parameters<AiPort['analyzeFrames']>
  ): ReturnType<AiPort['analyzeFrames']> {
    return this.visualProvider.analyzeFrames(...parameters);
  }

  synthesize(...parameters: Parameters<AiPort['synthesize']>): ReturnType<AiPort['synthesize']> {
    return this.analysisProvider.synthesize(...parameters);
  }
}
