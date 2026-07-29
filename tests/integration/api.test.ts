import type { AnalysisBatch, Job } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type ApiDependencies } from '../../apps/api/src/app.js';
import { loadConfig } from '../../packages/config/src/index.js';
import {
  IdempotencyConflictError,
  type CreateAnalysisBatchInput,
  type CreatedJob,
  type CreateJobInput,
} from '../../packages/database/src/index.js';
import { signRequest } from '../../packages/security/src/index.js';
import { validAnalysis } from '../fixtures/analysis.js';

const secret = 'test-secret-that-is-at-least-thirty-two-characters';
const body = JSON.stringify({
  title: 'ETM English Class',
  classDate: '2026-07-16',
  teacher: 'Alex Morgan',
  course: 'ETM English',
  analyzeVisuals: false,
});
const path = '/v1/classes/DEMOclass01/analyze';
const timestamp = Math.floor(Date.now() / 1000).toString();
const openApps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

function config(allowedCidrs = '127.0.0.1/32', localUiEnabled = false) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    ETM_API_SECRET: secret,
    OPENAI_API_KEY: 'test',
    ALLOWED_CIDRS: allowedCidrs,
    CADDY_TRUSTED_PROXIES: '127.0.0.1/32',
    LOCAL_UI_ENABLED: String(localUiEnabled),
    LOCAL_UI_ORIGIN: 'http://localhost:8080',
    ENABLE_VISUAL_ANALYSIS: String(localUiEnabled),
  });
}

function job(id = '39f5a245-b69d-4b99-95e9-a0e43c5e9ef9', overrides: Partial<Job> = {}): Job {
  const now = new Date();
  return {
    id,
    videoId: 'DEMOclass01',
    status: 'queued',
    progress: 0,
    requestPayload: JSON.parse(body) as object,
    resultJson: null,
    resultCharacterCount: null,
    warnings: null,
    errorCode: null,
    errorMessage: null,
    attemptCount: 0,
    idempotencyKey: 'request-key-123',
    payloadHash: 'hash',
    callbackStatus: 'pending',
    callbackAttempts: 0,
    callbackLastError: null,
    cancelRequestedAt: null,
    batchId: null,
    batchPosition: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

function batch(
  overrides: Partial<AnalysisBatch> = {},
  jobs: Job[] = [job()],
): AnalysisBatch & { jobs: Job[] } {
  const now = new Date();
  return {
    id: '6db014a1-f5ab-47d0-82c3-84e514f5db3d',
    name: 'English Usage — 2026-07-16',
    callbackStatus: 'not_sent',
    callbackAttempts: 0,
    callbackLastError: null,
    resultHash: null,
    resultCharacterCount: null,
    sentAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
    jobs,
  };
}

function dependencies(
  createJob: (input: CreateJobInput) => Promise<CreatedJob> = async () => ({
    job: job(),
    created: true,
  }),
): ApiDependencies {
  return {
    createJob: vi.fn(createJob),
    createBatch: vi.fn(async (input: CreateAnalysisBatchInput) => ({
      batch: batch(
        {},
        input.items.map((item, index) =>
          job(`00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, {
            videoId: item.videoId,
            requestPayload: item.payload,
            batchId: '6db014a1-f5ab-47d0-82c3-84e514f5db3d',
            batchPosition: index,
            callbackStatus: 'disabled',
          }),
        ),
      ),
    })),
    enqueue: vi.fn().mockResolvedValue(undefined),
    enqueueMany: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(null),
    getBatch: vi.fn().mockResolvedValue(null),
    listBatches: vi.fn().mockResolvedValue([]),
    enqueueBatchSend: vi.fn().mockResolvedValue(true),
    enqueueBatchJobRetry: vi.fn().mockResolvedValue(true),
    ready: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function authHeaders(rawBody = body) {
  return {
    'content-type': 'application/json',
    'x-etm-timestamp': timestamp,
    'x-etm-signature': signRequest(secret, timestamp, 'POST', path, rawBody),
    'idempotency-key': 'request-key-123',
  };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('authenticated analysis API', () => {
  it('creates a queued job with a valid signature and allowed IP', async () => {
    const deps = dependencies();
    const app = await buildApp(config(), deps);
    openApps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: authHeaders(),
      payload: body,
      remoteAddress: '127.0.0.1',
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      videoId: 'DEMOclass01',
      status: 'queued',
    });
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid signatures and unauthorized IPs generically', async () => {
    const app = await buildApp(config(), dependencies());
    openApps.push(app);
    const invalidSignature = await app.inject({
      method: 'POST',
      url: path,
      headers: { ...authHeaders(), 'x-etm-signature': '0'.repeat(64) },
      payload: body,
      remoteAddress: '127.0.0.1',
    });
    expect(invalidSignature.statusCode).toBe(401);
    expect(invalidSignature.json().message).toBe('Authentication failed');

    const unauthorizedIp = await app.inject({
      method: 'POST',
      url: path,
      headers: authHeaders(),
      payload: body,
      remoteAddress: '203.0.113.10',
    });
    expect(unauthorizedIp.statusCode).toBe(401);
    expect(unauthorizedIp.json()).toEqual(invalidSignature.json());
  });

  it('returns an existing job for duplicate body/key and enqueues only once', async () => {
    let calls = 0;
    const deps = dependencies(async () => {
      calls += 1;
      return { job: job(), created: calls === 1 };
    });
    const app = await buildApp(config(), deps);
    openApps.push(app);
    const request = {
      method: 'POST' as const,
      url: path,
      headers: authHeaders(),
      payload: body,
      remoteAddress: '127.0.0.1',
    };
    expect((await app.inject(request)).statusCode).toBe(202);
    expect((await app.inject(request)).statusCode).toBe(202);
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
  });

  it('rejects idempotency key reuse with a different payload', async () => {
    const deps = dependencies(async () => {
      throw new IdempotencyConflictError();
    });
    const app = await buildApp(config(), deps);
    openApps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: authHeaders(),
      payload: body,
      remoteAddress: '127.0.0.1',
    });
    expect(response.statusCode).toBe(409);
  });

  it('trusts forwarded client IP only from the configured Caddy proxy', async () => {
    const app = await buildApp(config('198.51.100.4/32'), dependencies());
    openApps.push(app);
    const proxied = await app.inject({
      method: 'POST',
      url: path,
      headers: { ...authHeaders(), 'x-forwarded-for': '198.51.100.4' },
      payload: body,
      remoteAddress: '127.0.0.1',
    });
    expect(proxied.statusCode).toBe(202);
  });
});

describe('local browser interface', () => {
  it('serves the local UI only when explicitly enabled', async () => {
    const disabled = await buildApp(config(), dependencies());
    openApps.push(disabled);
    expect((await disabled.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);

    const enabled = await buildApp(config('127.0.0.1/32', true), dependencies());
    openApps.push(enabled);
    const response = await enabled.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('ETM Class Engine');
    expect(response.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect((await enabled.inject({ method: 'GET', url: '/ui/config' })).json()).toEqual({
      visualAnalysisEnabled: true,
      maximumBatchVideos: 10,
    });
  });

  it('creates one atomic batch for one or more videos and enforces same-origin writes', async () => {
    const deps = dependencies();
    const app = await buildApp(config('127.0.0.1/32', true), deps);
    openApps.push(app);
    const payload = {
      name: 'English Usage — Thursday',
      videos: [
        {
          videoUrl: 'https://www.youtube.com/watch?v=U_t4DLT7eVQ',
          title: 'ETM English Class 1',
          classDate: '2026-07-16',
          teacher: 'Sebastián Mesías',
          course: 'English Usage',
          analyzeVisuals: true,
        },
        {
          videoUrl: 'https://www.youtube.com/watch?v=zXys9XxWvhg',
          title: 'ETM English Class 2',
          classDate: '2026-07-16',
          teacher: 'Sebastián Mesías',
          course: 'English Usage',
          analyzeVisuals: true,
        },
      ],
    };
    const forbidden = await app.inject({
      method: 'POST',
      url: '/ui/batches',
      headers: { origin: 'https://example.com' },
      payload,
    });
    expect(forbidden.statusCode).toBe(403);

    const accepted = await app.inject({
      method: 'POST',
      url: '/ui/batches',
      headers: { origin: 'http://localhost:8080' },
      payload,
    });
    expect(accepted.statusCode).toBe(202);
    expect(deps.createBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'English Usage — Thursday',
        items: [
          expect.objectContaining({ videoId: 'U_t4DLT7eVQ' }),
          expect.objectContaining({ videoId: 'zXys9XxWvhg' }),
        ],
      }),
    );
    expect(deps.enqueueMany).toHaveBeenCalledWith([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]);

    const single = await app.inject({
      method: 'POST',
      url: '/ui/batches',
      headers: { origin: 'http://localhost:8080' },
      payload: { ...payload, name: 'Single class', videos: [payload.videos[0]] },
    });
    expect(single.statusCode).toBe(202);
    expect(vi.mocked(deps.createBatch).mock.calls.at(-1)?.[0].items).toHaveLength(1);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/ui/batches',
      headers: { origin: 'http://localhost:8080' },
      payload: { ...payload, videos: [payload.videos[0], payload.videos[0]] },
    });
    expect(duplicate.statusCode).toBe(400);
  });

  it('assembles a deterministic result and queues one manual batch delivery', async () => {
    const deps = dependencies();
    const completedBatch = batch({}, [
      job('11111111-1111-4111-8111-111111111111', {
        videoId: 'U_t4DLT7eVQ',
        status: 'completed',
        progress: 100,
        callbackStatus: 'disabled',
        batchId: '6db014a1-f5ab-47d0-82c3-84e514f5db3d',
        batchPosition: 0,
        resultJson: validAnalysis(),
        resultCharacterCount: 100,
        completedAt: new Date('2026-07-16T19:00:00.000Z'),
      }),
      job('22222222-2222-4222-8222-222222222222', {
        videoId: 'zXys9XxWvhg',
        status: 'completed',
        progress: 100,
        callbackStatus: 'disabled',
        batchId: '6db014a1-f5ab-47d0-82c3-84e514f5db3d',
        batchPosition: 1,
        resultJson: validAnalysis('Second class'),
        resultCharacterCount: 100,
        completedAt: new Date('2026-07-16T20:00:00.000Z'),
      }),
    ]);
    vi.mocked(deps.getBatch).mockResolvedValue(completedBatch);
    const app = await buildApp(config('127.0.0.1/32', true), deps);
    openApps.push(app);

    const result = await app.inject({
      method: 'GET',
      url: '/ui/batches/6db014a1-f5ab-47d0-82c3-84e514f5db3d/result',
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      batch: { class_count: 2, status: 'ready' },
      order: ['U_t4DLT7eVQ', 'zXys9XxWvhg'],
      classes: {
        U_t4DLT7eVQ: { job_id: '11111111-1111-4111-8111-111111111111' },
        zXys9XxWvhg: { job_id: '22222222-2222-4222-8222-222222222222' },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/ui/batches/6db014a1-f5ab-47d0-82c3-84e514f5db3d/send',
      headers: { origin: 'http://localhost:8080' },
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    expect(deps.enqueueBatchSend).toHaveBeenCalledOnce();
    expect(deps.enqueue).not.toHaveBeenCalled();

    const retry = await app.inject({
      method: 'POST',
      url: '/ui/batches/6db014a1-f5ab-47d0-82c3-84e514f5db3d/jobs/22222222-2222-4222-8222-222222222222/retry',
      headers: { origin: 'http://localhost:8080' },
      payload: {},
    });
    expect(retry.statusCode).toBe(202);
    expect(deps.enqueueBatchJobRetry).toHaveBeenCalledWith(
      '6db014a1-f5ab-47d0-82c3-84e514f5db3d',
      '22222222-2222-4222-8222-222222222222',
    );
  });
});
