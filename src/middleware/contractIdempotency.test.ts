import express from 'express';
import request from 'supertest';

import {
  createContractIdempotencyMiddleware,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from './contractIdempotency';
import { InMemoryContractIdempotencyStore } from './contractIdempotencyStore';

/**
 * Builds an isolated Express app that mimics POST /api/v1/contracts with a
 * mock "milestone release" handler. The handler counts executions so tests
 * can prove the side effect ran exactly once.
 */
function buildApp(
  store: InMemoryContractIdempotencyStore,
  options: { ttlMs?: number } = {},
): { app: express.Express; releases: () => number } {
  let releases = 0;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    (req as express.Request & { user?: { id: string } }).user = {
      id: req.header('X-Test-User') ?? 'user-a',
    };
    res.locals.requestId = 'contract-idempotency-test';
    next();
  });
  app.post(
    '/api/v1/contracts',
    createContractIdempotencyMiddleware({
      store,
      ttlMs: options.ttlMs,
    }),
    (req, res) => {
      releases += 1;
      res.status(201).json({
        status: 'success',
        data: { id: 'contract-1', title: req.body.title },
        requestId: 'contract-idempotency-test',
      });
    },
  );
  return { app, releases: () => releases };
}

describe('contract idempotency middleware', () => {
  it('passes through unchanged when Idempotency-Key is absent', async () => {
    const store = new InMemoryContractIdempotencyStore();
    const { app, releases } = buildApp(store);
    const body = { title: 'Milestone' };

    await request(app).post('/api/v1/contracts').send(body).expect(201);
    await request(app).post('/api/v1/contracts').send(body).expect(201);

    expect(releases()).toBe(2);
    expect(store.size()).toBe(0);
  });

  it('replays the identical response and executes the release only once', async () => {
    const store = new InMemoryContractIdempotencyStore();
    const { app, releases } = buildApp(store);

    const first = await request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'key-1')
      .send({ title: 'Milestone', budget: 100 })
      .expect(201);

    // Same logical body with reordered keys must fingerprint identically.
    const replay = await request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'key-1')
      .send({ budget: 100, title: 'Milestone' })
      .expect(201);

    expect(releases()).toBe(1);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(store.size()).toBe(1);
  });

  it('returns 409 idempotency_conflict when the key is reused with a different body', async () => {
    const store = new InMemoryContractIdempotencyStore();
    const { app, releases } = buildApp(store);

    await request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'key-2')
      .send({ title: 'First' })
      .expect(201);

    const conflict = await request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'key-2')
      .send({ title: 'Different' })
      .expect(409);

    expect(conflict.body.error.code).toBe('idempotency_conflict');
    expect(releases()).toBe(1);
  });

  it('releases the reservation on a failed first attempt so a retry re-executes', async () => {
    const store = new InMemoryContractIdempotencyStore();
    let releases = 0;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      (req as express.Request & { user?: { id: string } }).user = { id: 'user-a' };
      res.locals.requestId = 'contract-idempotency-test';
      next();
    });
    app.post(
      '/api/v1/contracts',
      createContractIdempotencyMiddleware({ store }),
      (req, res) => {
        releases += 1;
        if (releases === 1) {
          res.status(500).json({
            status: 'error',
            error: {
              code: 'internal_error',
              message: 'transient failure',
              requestId: 'contract-idempotency-test',
            },
          });
          return;
        }
        res.status(201).json({
          status: 'success',
          data: { id: 'contract-1', title: req.body.title },
          requestId: 'contract-idempotency-test',
        });
      },
    );

    const body = { title: 'Retryable' };
    await request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'retry')
      .send(body)
      .expect(500);
    await request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'retry')
      .send(body)
      .expect(201);

    expect(releases).toBe(2);
  });

  it('allows exactly one concurrent request and rejects the other with request_in_progress', async () => {
    const store = new InMemoryContractIdempotencyStore();

    let enterResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterResolve = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let releases = 0;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      (req as express.Request & { user?: { id: string } }).user = { id: 'user-a' };
      res.locals.requestId = 'contract-idempotency-test';
      next();
    });
    app.post(
      '/api/v1/contracts',
      createContractIdempotencyMiddleware({ store }),
      async (req, res) => {
        releases += 1;
        enterResolve();
        await gate;
        res.status(201).json({
          status: 'success',
          data: { id: 'contract-1', title: req.body.title },
          requestId: 'contract-idempotency-test',
        });
      },
    );

    const body = { title: 'Concurrent' };
    // `.then` eagerly dispatches the (otherwise lazy) supertest request, so
    // request #1 actually reaches the middleware before we wait on `entered`.
    const firstPromise = request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'concurrent')
      .send(body)
      .then((res) => res);

    // Wait until the first request has reserved the key and is blocked on the
    // gate, then fire the overlapping second request.
    await entered;
    const second = await request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'concurrent')
      .send(body);

    releaseGate();
    const first = await firstPromise;

    expect(releases).toBe(1);
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('request_in_progress');
  });

  it('treats the same key as a new request after TTL expiry', async () => {
    let now = 1_000_000;
    const store = new InMemoryContractIdempotencyStore({ clock: () => now });
    const { app, releases } = buildApp(store, { ttlMs: 100 });
    const body = { title: 'Expiring' };

    await request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'expiring')
      .send(body)
      .expect(201);

    now += 101;

    await request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'expiring')
      .send(body)
      .expect(201);

    expect(releases()).toBe(2);
  });

  it('isolates the same key across tenants', async () => {
    const store = new InMemoryContractIdempotencyStore();
    const { app, releases } = buildApp(store);
    const body = { title: 'Shared' };

    await request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'shared')
      .set('X-Test-User', 'user-a')
      .send(body)
      .expect(201);
    await request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'shared')
      .set('X-Test-User', 'user-b')
      .send(body)
      .expect(201);

    expect(releases()).toBe(2);
    expect(store.size()).toBe(2);
  });

  it('rejects a malformed (empty/whitespace) key with 400', async () => {
    const store = new InMemoryContractIdempotencyStore();
    const { app, releases } = buildApp(store);

    for (const key of ['', '   ']) {
      const res = await request(app)
        .post('/api/v1/contracts')
        .set('Idempotency-Key', key)
        .send({ title: 'x' })
        .expect(400);
      expect(res.body.error.code).toBe('invalid_idempotency_key');
    }

    expect(releases()).toBe(0);
    expect(store.size()).toBe(0);
  });

  it('rejects an oversized key with 400', async () => {
    const store = new InMemoryContractIdempotencyStore();
    const { app, releases } = buildApp(store);

    const res = await request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'x'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1))
      .send({ title: 'x' })
      .expect(400);

    expect(res.body.error.code).toBe('invalid_idempotency_key');
    expect(releases()).toBe(0);
    expect(store.size()).toBe(0);
  });
});
