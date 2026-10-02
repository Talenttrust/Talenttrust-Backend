/**
 * @file app.state-invariants.test.ts
 *
 * Focused regression tests for the process-wide state that `src/app.ts` owns.
 *
 * Covers the four invariants documented in `src/app.ts`:
 *  - INV-1 the metrics registry is initialised once and reused by later calls
 *  - INV-2 the terminal 404/error pair is mounted exactly once, and only after
 *    every other layer (the pattern `src/index.ts` relies on)
 *  - INV-3 every router is mounted on exactly one path
 *  - INV-4 shutdown releases every rate-limit store this module owns, once
 *
 * The database is stubbed: these tests only inspect wiring and teardown, so
 * opening SQLite would add nothing but side effects.
 */

import express from 'express';
import request from 'supertest';

jest.mock('./db/database', () => ({
  getDb: jest.fn(() => ({})),
  closeDb: jest.fn(),
}));

import { createApp, attachTerminalHandlers, shutdownRateLimitStore } from './app';
import { getMetricsService } from './observability/registry';
import apiKeysRouter from './routes/apiKeys.routes';
import { rateLimitStore, apiKeysRateLimitStore } from './config/rateLimit';
import { logger } from './logger';

interface RouterStackLayer {
  handle: unknown;
}

function stackOf(app: express.Application): RouterStackLayer[] {
  const router = (app as unknown as { _router?: { stack?: RouterStackLayer[] } })._router;
  return router?.stack ?? [];
}

/** Number of layers currently mounted on the app. */
function stackDepth(app: express.Application): number {
  return stackOf(app).length;
}

/** Number of times a given router object is mounted on the app. */
function countRouterMounts(app: express.Application, router: unknown): number {
  return stackOf(app).filter((layer) => layer.handle === router).length;
}

describe('app factory — INV-1 metrics registry is initialised once', () => {
  it('does not replace the global metrics service when the factory runs again', () => {
    createApp();
    const first = getMetricsService();

    createApp();

    // Routers are wired with the resolved instance, so the registry must still
    // be the very same object after a second factory call.
    expect(getMetricsService()).toBe(first);
  });
});

describe('app factory — INV-2 terminal handlers mounted once and last', () => {
  it('mounts the terminal pair exactly once per application', () => {
    const app = express();
    const before = stackDepth(app);

    attachTerminalHandlers(app);
    const afterFirst = stackDepth(app);

    attachTerminalHandlers(app);

    expect(afterFirst - before).toBe(2);
    expect(stackDepth(app)).toBe(afterFirst);
  });

  it('ignores a redundant attach on an app the factory already sealed', () => {
    const app = createApp();
    const depth = stackDepth(app);

    attachTerminalHandlers(app);

    expect(stackDepth(app)).toBe(depth);
  });

  it('keeps late routes reachable when handlers are attached after them', async () => {
    // The supported pattern, mirroring src/index.ts: skip the terminal pair,
    // mount the remaining routes, then seal the app.
    const app = createApp({ includeTerminalHandlers: false });
    app.get('/test-only/late', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    attachTerminalHandlers(app);

    const res = await request(app).get('/test-only/late');

    expect(res.status).toBe(200);
  });

  it('still returns a 404 envelope for unmatched paths', async () => {
    const app = createApp();

    const res = await request(app).get('/test-only/definitely-missing');

    expect(res.status).toBe(404);
  });
});

describe('app factory — INV-3 each router mounted once', () => {
  it('mounts the API-key router a single time', () => {
    const app = createApp();

    expect(countRouterMounts(app, apiKeysRouter)).toBe(1);
  });
});

describe('app factory — INV-4 rate-limit store teardown', () => {
  // Declared last: it destroys the shared stores, so it must not race the
  // wiring assertions above. No other test in this file is rate limited.
  it('releases every owned store exactly once across repeated shutdown calls', () => {
    const infoSpy = jest.spyOn(logger, 'info');

    expect(rateLimitStore.destroyed).toBe(false);
    expect(apiKeysRateLimitStore.destroyed).toBe(false);

    shutdownRateLimitStore();
    shutdownRateLimitStore();

    expect(rateLimitStore.destroyed).toBe(true);
    expect(apiKeysRateLimitStore.destroyed).toBe(true);

    const shutdownCalls = infoSpy.mock.calls.filter(
      ([message]) => message === 'rate_limit_stores_shutdown_complete',
    );
    expect(shutdownCalls).toHaveLength(1);
    expect(shutdownCalls[0][1]).toEqual({
      stores: ['rate_limit_store', 'api_keys_rate_limit_store'],
    });

    infoSpy.mockRestore();
  });
});