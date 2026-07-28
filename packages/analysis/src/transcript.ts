import type { AudioChunk } from './media.js';
import type { ProcessingWarning, TranscriptSegment } from '../../shared/src/index.js';

export interface RawTranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface ChunkTranscription {
  text: string;
  segments: RawTranscriptionSegment[];
  warning?: string;
}

export function formatTimestamp(totalSeconds: number): string {
  const rounded = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

export function deduplicateOverlap(previous: string, current: string, maximumWords = 50): string {
  const left = previous.trim().split(/\s+/);
  const right = current.trim().split(/\s+/);
  const maximum = Math.min(maximumWords, left.length, right.length);
  for (let length = maximum; length >= 3; length -= 1) {
    const suffix = left.slice(-length).join(' ').toLocaleLowerCase();
    const prefix = right.slice(0, length).join(' ').toLocaleLowerCase();
    if (suffix === prefix) return right.slice(length).join(' ');
  }
  return current.trim();
}

export function normalizeTranscriptions(
  chunks: AudioChunk[],
  transcriptions: ChunkTranscription[],
): { segments: TranscriptSegment[]; warnings: ProcessingWarning[] } {
  const output: TranscriptSegment[] = [];
  const warnings: ProcessingWarning[] = [];
  let priorText = '';
  for (const [index, transcription] of transcriptions.entries()) {
    const chunk = chunks[index];
    if (!chunk) continue;
    if (transcription.warning) {
      warnings.push({
        code: 'TRANSCRIPTION_WARNING',
        message: transcription.warning,
        chunkIndex: chunk.chunkIndex,
      });
    }
    for (const segment of transcription.segments) {
      const cleaned = deduplicateOverlap(priorText, segment.text);
      if (!cleaned) continue;
      output.push({
        start: formatTimestamp(chunk.startSeconds + segment.start),
        end: formatTimestamp(Math.min(chunk.startSeconds + segment.end, chunk.endSeconds)),
        speaker: null,
        text: cleaned,
      });
      priorText = `${priorText} ${cleaned}`.trim().split(/\s+/).slice(-100).join(' ');
    }
  }
  return { segments: output, warnings };
}

export function transcriptAsText(segments: TranscriptSegment[]): string {
  return segments
    .map(
      (segment) =>
        `[${segment.start} - ${segment.end}]${segment.speaker ? ` ${segment.speaker}:` : ''} ${segment.text}`,
    )
    .join('\n');
}
