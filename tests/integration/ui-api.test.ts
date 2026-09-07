import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type ApiDependencies } from '../../apps/api/src/app.js';
import type { UiDependencies } from '../../apps/api/src/ui.js';
import { loadConfig } from '../../packages/config/src/index.js';

const openApps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

function apiDependencies(): ApiDependencies {
  return {
    createJob: vi.fn(),
    enqueue: vi.fn(),
    getJob: vi.fn(),
    ready: vi.fn(),
    close: vi.fn(),
  };
}

function uiDependencies(): UiDependencies {
  return {
    createBatch: vi.fn(),
    listBatches: vi.fn().mockResolvedValue([]),
    getBatch: vi.fn(),
    enqueue: vi.fn(),
    retryJob: vi.fn(),
    deliverBatch: vi.fn(),
  };
}

function config() {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    ETM_API_SECRET: 'test-secret-that-is-at-least-thirty-two-characters',
    OPENAI_API_KEY: 'test',
    WEB_UI_ENABLED: 'true',
    WEB_ADMIN_PASSWORD: 'a-secure-test-password',
    WEB_ASSETS_PATH: 'apps/web/dist',
  });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('operator web interface', () => {
  it('serves the interface and protects batch data behind an operator session', async () => {
    const ui = uiDependencies();
    const app = await buildApp(config(), apiDependencies(), undefined, ui);
    openApps.push(app);

    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.headers['content-type']).toContain('text/html');

    expect((await app.inject({ method: 'GET', url: '/ui-api/batches' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/ui-api/session',
          payload: { password: 'incorrect-password' },
        })
      ).statusCode,
    ).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/ui-api/session',
      payload: { password: 'a-secure-test-password' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'];
    expect(cookie).toContain('HttpOnly');

    const batches = await app.inject({
      method: 'GET',
      url: '/ui-api/batches',
      headers: { cookie },
    });
    expect(batches.statusCode).toBe(200);
    expect(batches.json()).toEqual({ batches: [] });
    expect(ui.listBatches).toHaveBeenCalledOnce();
  });

  it('requires the UI request marker for mutations after login', async () => {
    const app = await buildApp(config(), apiDependencies(), undefined, uiDependencies());
    openApps.push(app);
    const login = await app.inject({
      method: 'POST',
      url: '/ui-api/session',
      payload: { password: 'a-secure-test-password' },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/ui-api/jobs/39f5a245-b69d-4b99-95e9-a0e43c5e9ef9/retry',
      headers: { cookie: login.headers['set-cookie'] },
    });
    expect(response.statusCode).toBe(403);
  });
});
