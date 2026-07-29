import type { Job } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type ApiDependencies } from '../../apps/api/src/app.js';
import { loadConfig } from '../../packages/config/src/index.js';
import {
  IdempotencyConflictError,
  type CreatedJob,
  type CreateJobInput,
} from '../../packages/database/src/index.js';
import { signRequest } from '../../packages/security/src/index.js';

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
    createdAt: now,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
    ...overrides,
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
    enqueue: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(null),
    listJobs: vi.fn().mockResolvedValue([]),
    enqueueCallbackRetry: vi.fn().mockResolvedValue(undefined),
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
    });
  });

  it('creates a local job from a YouTube URL and enforces same-origin writes', async () => {
    const deps = dependencies();
    const app = await buildApp(config('127.0.0.1/32', true), deps);
    openApps.push(app);
    const payload = {
      videoUrl: 'https://www.youtube.com/watch?v=U_t4DLT7eVQ',
      title: 'ETM English Class',
      classDate: '2026-07-16',
      teacher: 'Sebastián Mesías',
      course: 'Workshops V8',
      analyzeVisuals: true,
    };
    const forbidden = await app.inject({
      method: 'POST',
      url: '/ui/jobs',
      headers: { origin: 'https://example.com' },
      payload,
    });
    expect(forbidden.statusCode).toBe(403);

    const accepted = await app.inject({
      method: 'POST',
      url: '/ui/jobs',
      headers: { origin: 'http://localhost:8080' },
      payload,
    });
    expect(accepted.statusCode).toBe(202);
    expect(deps.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: 'U_t4DLT7eVQ' }),
    );
    expect(deps.enqueue).toHaveBeenCalledOnce();
  });

  it('queues callback redelivery without rerunning the analysis', async () => {
    const deps = dependencies();
    vi.mocked(deps.getJob).mockResolvedValue(
      job(undefined, {
        status: 'completed',
        progress: 100,
        callbackStatus: 'failed',
        resultJson: { schema_version: 1 },
      }),
    );
    const app = await buildApp(config('127.0.0.1/32', true), deps);
    openApps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/ui/jobs/39f5a245-b69d-4b99-95e9-a0e43c5e9ef9/retry-callback',
      headers: { origin: 'http://localhost:8080' },
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    expect(deps.enqueueCallbackRetry).toHaveBeenCalledOnce();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
});
