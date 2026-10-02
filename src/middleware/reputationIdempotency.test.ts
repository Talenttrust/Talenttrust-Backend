import express from 'express';
import request from 'supertest';

import { InMemoryIdempotencyStore } from '../db/idempotencyStore';
import { createReputationIdempotencyMiddleware } from './reputationIdempotency';

function buildApp(store: InMemoryIdempotencyStore) {
  let writes = 0;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.header('X-No-User') !== 'true') {
      (req as typeof req & { user?: { id: string } }).user = {
        id: req.header('X-Test-User') ?? 'user-a',
      };
    }
    res.locals.requestId = 'reputation-idempotency-test';
    next();
  });
  app.put(
    '/reputation/:id',
    createReputationIdempotencyMiddleware({ store }),
    (req, res) => {
      writes += 1;
      res.status(201).json({ status: 'success', data: req.body, writes });
    },
  );
  app.post(
    '/reputation/bulk',
    createReputationIdempotencyMiddleware({ store }),
    (req, res) => {
      writes += 1;
      res.status(202).json({ status: 'accepted', data: req.body, writes });
    },
  );
  return { app, writes: () => writes };
}

describe('reputation idempotency middleware', () => {
  it('passes through when Idempotency-Key is absent', async () => {
    const { app, writes } = buildApp(new InMemoryIdempotencyStore({ sweepIntervalMs: 0 }));
    await request(app).put('/reputation/freelancer-a').send({ rating: 5 }).expect(201);
    await request(app).put('/reputation/freelancer-a').send({ rating: 5 }).expect(201);
    expect(writes()).toBe(2);
  });

  it('stores the first write and replays its exact status and body', async () => {
    const store = new InMemoryIdempotencyStore({ sweepIntervalMs: 0 });
    const { app, writes } = buildApp(store);
    const first = await request(app)
      .put('/reputation/freelancer-a')
      .set('Idempotency-Key', 'rating-1')
      .send({ reviewerId: 'reviewer-a', rating: 5 })
      .expect(201);
    const replay = await request(app)
      .put('/reputation/freelancer-a')
      .set('Idempotency-Key', 'rating-1')
      .send({ rating: 5, reviewerId: 'reviewer-a' })
      .expect(201);

    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(writes()).toBe(1);
    expect(store.size()).toBe(1);
  });

  it('returns 409 when a key is reused with a different payload', async () => {
    const { app, writes } = buildApp(
      new InMemoryIdempotencyStore({ sweepIntervalMs: 0 }),
    );
    await request(app)
      .put('/reputation/freelancer-a')
      .set('Idempotency-Key', 'rating-conflict')
      .send({ rating: 5 })
      .expect(201);
    const conflict = await request(app)
      .put('/reputation/freelancer-a')
      .set('Idempotency-Key', 'rating-conflict')
      .send({ rating: 1 })
      .expect(409);

    expect(conflict.body.error.code).toBe('idempotency_payload_conflict');
    expect(conflict.body.error.requestId).toBe('reputation-idempotency-test');
    expect(writes()).toBe(1);
  });

  it('scopes the same key by caller, route, and HTTP method', async () => {
    const { app, writes } = buildApp(
      new InMemoryIdempotencyStore({ sweepIntervalMs: 0 }),
    );
    await request(app)
      .put('/reputation/freelancer-a')
      .set('Idempotency-Key', 'shared')
      .set('X-Test-User', 'user-a')
      .send({ rating: 5 })
      .expect(201);
    await request(app)
      .put('/reputation/freelancer-a')
      .set('Idempotency-Key', 'shared')
      .set('X-Test-User', 'user-b')
      .send({ rating: 5 })
      .expect(201);
    await request(app)
      .post('/reputation/bulk')
      .set('Idempotency-Key', 'shared')
      .set('X-Test-User', 'user-a')
      .send({ rating: 5 })
      .expect(202);
    expect(writes()).toBe(3);
  });

  it('expires old keys and processes the retry as a new write', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const store = new InMemoryIdempotencyStore({
      ttlMs: 100,
      clock: () => now,
      sweepIntervalMs: 0,
    });
    const { app, writes } = buildApp(store);

    await request(app)
      .put('/reputation/freelancer-a')
      .set('Idempotency-Key', 'expiring')
      .send({ rating: 5 })
      .expect(201);
    now = new Date(now.getTime() + 101);
    await request(app)
      .put('/reputation/freelancer-a')
      .set('Idempotency-Key', 'expiring')
      .send({ rating: 5 })
      .expect(201);
    expect(writes()).toBe(2);
  });

  it('uses the bounded store eviction policy', async () => {
    const store = new InMemoryIdempotencyStore({
      maxSize: 2,
      sweepIntervalMs: 0,
    });
    const { app } = buildApp(store);
    for (const key of ['one', 'two', 'three']) {
      await request(app)
        .put('/reputation/freelancer-a')
        .set('Idempotency-Key', key)
        .send({ rating: 5 })
        .expect(201);
    }
    expect(store.size()).toBe(2);
  });

  it.each(['', ' '.repeat(3), 'x'.repeat(256)])(
    'rejects invalid key %j',
    async key => {
      const { app, writes } = buildApp(
        new InMemoryIdempotencyStore({ sweepIntervalMs: 0 }),
      );
      const response = await request(app)
        .put('/reputation/freelancer-a')
        .set('Idempotency-Key', key)
        .send({ rating: 5 });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('invalid_idempotency_key');
      expect(writes()).toBe(0);
    },
  );

  it('rejects an idempotent write when authentication context is absent', async () => {
    const { app, writes } = buildApp(
      new InMemoryIdempotencyStore({ sweepIntervalMs: 0 }),
    );
    const response = await request(app)
      .put('/reputation/freelancer-a')
      .set('Idempotency-Key', 'authenticated-scope-required')
      .set('X-No-User', 'true')
      .send({ rating: 5 });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
    expect(writes()).toBe(0);
  });
});
