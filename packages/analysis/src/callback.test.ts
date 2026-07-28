import { describe, expect, it, vi } from 'vitest';
import { CallbackSender, isRetryableCallbackStatus } from './callback.js';

describe('callback retry classification', () => {
  it('retries transient responses only', () => {
    expect(isRetryableCallbackStatus(408)).toBe(true);
    expect(isRetryableCallbackStatus(429)).toBe(true);
    expect(isRetryableCallbackStatus(503)).toBe(true);
    expect(isRetryableCallbackStatus(400)).toBe(false);
  });

  it('retries and reuses a stable callback identifier', async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sender = new CallbackSender('https://callback.test', 'x'.repeat(32), 2, fakeFetch);
    const result = await sender.send({ ok: true }, 'stable-id');
    expect(result).toEqual({ attempts: 2, callbackId: 'stable-id' });
    expect(fakeFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      'idempotency-key': 'stable-id',
    });
    expect(fakeFetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      'idempotency-key': 'stable-id',
    });
  });
});
