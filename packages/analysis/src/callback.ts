import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { signCallback } from '../../security/src/index.js';
import { PipelineError } from './errors.js';

export interface CallbackResult {
  attempts: number;
  callbackId: string;
}

export function isRetryableCallbackStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class CallbackSender {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly maximumAttempts: number,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async send(payload: unknown, callbackId: string = randomUUID()): Promise<CallbackResult> {
    if (!this.url) return { attempts: 0, callbackId };
    const body = JSON.stringify(payload);
    let lastError = 'Callback delivery failed';
    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      try {
        const response = await this.fetchImplementation(this.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-etm-timestamp': timestamp,
            'x-etm-signature': signCallback(this.secret, timestamp, body),
            'idempotency-key': callbackId,
          },
          body,
          signal: AbortSignal.timeout(30_000),
        });
        if (response.ok) return { attempts: attempt, callbackId };
        lastError = `Callback returned HTTP ${String(response.status)}`;
        if (!isRetryableCallbackStatus(response.status)) {
          throw new PipelineError('CALLBACK_FAILED', lastError, false);
        }
      } catch (error) {
        if (error instanceof PipelineError && !error.retryable) throw error;
        lastError = error instanceof Error ? error.message : lastError;
      }
      if (attempt < this.maximumAttempts) {
        const exponential = Math.min(30_000, 500 * 2 ** (attempt - 1));
        const jitter = Math.floor(Math.random() * 250);
        await delay(exponential + jitter);
      }
    }
    throw new PipelineError('CALLBACK_FAILED', lastError, true);
  }
}
