import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, statfs, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { PipelineError } from './errors.js';
import { runProcess } from './process.js';

export interface AudioChunk {
  chunkIndex: number;
  startSeconds: number;
  endSeconds: number;
  path: string;
}

export interface VideoFrame {
  timestampSeconds: number;
  path: string;
}

export function planAudioChunks(
  durationSeconds: number,
  chunkSeconds = 600,
  overlapSeconds = 3,
): Omit<AudioChunk, 'path'>[] {
  if (
    durationSeconds <= 0 ||
    chunkSeconds <= 0 ||
    overlapSeconds < 0 ||
    overlapSeconds >= chunkSeconds
  ) {
    throw new Error('Invalid audio chunk parameters');
  }
  const chunks: Omit<AudioChunk, 'path'>[] = [];
  const step = chunkSeconds - overlapSeconds;
  for (let start = 0, index = 0; start < durationSeconds; start += step, index += 1) {
    const end = Math.min(start + chunkSeconds, durationSeconds);
    chunks.push({ chunkIndex: index, startSeconds: start, endSeconds: end });
    if (end === durationSeconds) break;
  }
  return chunks;
}

export function ffmpegAudioArgs(input: string, chunk: AudioChunk): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(chunk.startSeconds),
    '-i',
    input,
    '-t',
    String(chunk.endSeconds - chunk.startSeconds),
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '48k',
    '-y',
    chunk.path,
  ];
}

export class MediaProcessor {
  constructor(
    private readonly ffmpegTimeoutMs: number,
    private readonly minimumFreeBytes: number,
  ) {}

  async assertDiskSpace(directory: string): Promise<void> {
    const stats = await statfs(directory);
    const available = stats.bavail * stats.bsize;
    if (available < this.minimumFreeBytes) {
      throw new PipelineError(
        'INSUFFICIENT_DISK_SPACE',
        'Insufficient free disk space to process the job',
        true,
      );
    }
  }

  async extractAudioChunks(
    input: string,
    directory: string,
    durationSeconds: number,
    chunkSeconds: number,
    overlapSeconds: number,
  ): Promise<AudioChunk[]> {
    const chunksDirectory = join(directory, 'audio-chunks');
    await mkdir(chunksDirectory, { recursive: true, mode: 0o700 });
    const plans = planAudioChunks(durationSeconds, chunkSeconds, overlapSeconds);
    const chunks = plans.map((chunk) => ({
      ...chunk,
      path: join(chunksDirectory, `chunk-${String(chunk.chunkIndex).padStart(4, '0')}.mp3`),
    }));
    for (const chunk of chunks) {
      await runProcess('ffmpeg', ffmpegAudioArgs(input, chunk), {
        timeoutMs: this.ffmpegTimeoutMs,
      });
    }
    return chunks;
  }

  async extractFrames(
    input: string,
    directory: string,
    durationSeconds: number,
    maximumFrames: number,
  ): Promise<VideoFrame[]> {
    const frameDirectory = join(directory, 'frames');
    await mkdir(frameDirectory, { recursive: true, mode: 0o700 });
    const periodicInterval = Math.max(
      30,
      Math.ceil(durationSeconds / Math.max(1, maximumFrames / 2)),
    );
    const candidates = new Set<number>();
    for (let time = 0; time < durationSeconds; time += periodicInterval) candidates.add(time);

    const sceneResult = await runProcess(
      'ffmpeg',
      [
        '-hide_banner',
        '-i',
        input,
        '-vf',
        "select='gt(scene,0.35)',showinfo",
        '-vsync',
        'vfr',
        '-f',
        'null',
        '-',
      ],
      { timeoutMs: this.ffmpegTimeoutMs, maxOutputBytes: 20_000_000 },
    ).catch((error: unknown) => ({
      stdout: '',
      stderr: error instanceof Error ? error.message : '',
    }));
    for (const match of sceneResult.stderr.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) {
      const time = Number(match[1]);
      if (Number.isFinite(time) && time >= 0 && time < durationSeconds) candidates.add(time);
    }

    const orderedCandidates = [...candidates]
      .sort((left, right) => left - right)
      .filter((time, index, all) => index === 0 || time - (all[index - 1] ?? 0) >= 2);
    const selected = sampleEvenly(orderedCandidates, maximumFrames * 2);
    const frames: VideoFrame[] = [];
    const hashes = new Set<string>();
    const fingerprints: Buffer[] = [];
    for (const [index, time] of selected.entries()) {
      if (frames.length >= maximumFrames) break;
      const path = join(frameDirectory, `frame-${String(index).padStart(4, '0')}.jpg`);
      await runProcess(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          String(time),
          '-i',
          input,
          '-frames:v',
          '1',
          '-vf',
          "scale='min(1280,iw)':-2",
          '-q:v',
          '5',
          '-y',
          path,
        ],
        { timeoutMs: this.ffmpegTimeoutMs },
      );
      const hash = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
      const fingerprintPath = `${path}.gray`;
      await runProcess(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          path,
          '-vf',
          'scale=16:16,format=gray',
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-y',
          fingerprintPath,
        ],
        { timeoutMs: this.ffmpegTimeoutMs },
      );
      const fingerprint = await readFile(fingerprintPath);
      await unlink(fingerprintPath);
      if (hashes.has(hash) || fingerprints.some((prior) => perceptuallyNear(prior, fingerprint))) {
        await unlink(path);
      } else {
        hashes.add(hash);
        fingerprints.push(fingerprint);
        frames.push({ timestampSeconds: time, path });
      }
    }
    return frames;
  }

  async findDownloadedMedia(directory: string, prefix: 'audio' | 'source'): Promise<string> {
    const names = await readdir(directory);
    const name = names.find((candidate) => basename(candidate).startsWith(`${prefix}.`));
    return z.string().parse(name ? join(directory, name) : undefined);
  }
}

function perceptuallyNear(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length || left.length === 0) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
  }
  return difference / left.length <= 4;
}

function sampleEvenly(values: number[], limit: number): number[] {
  if (values.length <= limit) return values;
  return Array.from({ length: limit }, (_, index) => {
    const position = Math.round((index * (values.length - 1)) / (limit - 1));
    return values[position] ?? 0;
  });
}
