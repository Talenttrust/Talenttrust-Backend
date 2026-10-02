import express from 'express';
import request from 'supertest';
import { createAuditRouter } from './router';
import { AuditService } from './service';
import { clearIdempotencyStore } from '../middleware/idempotency';

function fixture() {
  const log = jest.fn((input) => ({ id: 'entry-1', ...input }));
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.requestId = 'req-1';
    res.locals.correlationId = 'corr-1';
    next();
  });
  app.use(
    '/audit',
    createAuditRouter({
      service: { log } as unknown as AuditService,
      accessMiddleware: [
        (req, res, next) => {
          if (req.headers.authorization !== 'allowed') {
            res.status(403).json({ error: 'forbidden' });
            return;
          }
          next();
        },
      ],
    }),
  );
  return { app, log };
}

const valid = {
  action: 'CONTRACT_CREATED',
  severity: 'INFO',
  actor: 'user-1',
  resource: 'contract',
  resourceId: 'c-1',
};
afterEach(() => clearIdempotencyStore());

describe('live audit validation boundary', () => {
  it('deduplicates concurrent requests without additional appends', async () => {
    const { app, log } = fixture();
    const responses = await Promise.all(Array.from({ length: 10 }, () =>
      request(app).post('/audit').set('Authorization', 'allowed')
        .set('Idempotency-Key', 'concurrent').send(valid),
    ));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(9);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('defaults metadata, propagates safe context and replays the original request without another write', async () => {
    const { app, log } = fixture();
    const first = await request(app)
      .post('/audit')
      .set('Authorization', 'allowed')
      .set('Idempotency-Key', 'replay')
      .send(valid);
    expect(first.status).toBe(201);
    expect(first.body.metadata).toEqual({});
    expect(first.body.correlationId).toBe('corr-1');
    const replay = await request(app)
      .post('/audit')
      .set('Authorization', 'allowed')
      .set('Idempotency-Key', 'replay')
      .send(valid);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotencyHeader).toBe('replay-detected');
    expect(log).toHaveBeenCalledTimes(1);
    const conflict = await request(app)
      .post('/audit')
      .set('Authorization', 'allowed')
      .set('Idempotency-Key', 'replay')
      .send({ ...valid, metadata: {} });
    expect(conflict.status).toBe(409);
  });

  it.each([
    { metadata: { a: { b: { c: { d: { e: {} } } } } } },
    { actor: '   ' },
    { extra: true },
  ])('rejects invalid requests before a write or replay reservation', async (extra) => {
    const { app, log } = fixture();
    const response = await request(app)
      .post('/audit')
      .set('Authorization', 'allowed')
      .set('Idempotency-Key', 'invalid')
      .send({ ...valid, ...extra });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.correlationId).toBe('corr-1');
    expect(log).not.toHaveBeenCalled();
    const corrected = await request(app)
      .post('/audit')
      .set('Authorization', 'allowed')
      .set('Idempotency-Key', 'invalid')
      .send(valid);
    expect(corrected.status).toBe(201);
  });

  it('checks access before validation and before replaying a cached write', async () => {
    const { app, log } = fixture();
    await request(app)
      .post('/audit')
      .set('Authorization', 'allowed')
      .set('Idempotency-Key', 'auth')
      .send(valid);
    expect(
      (await request(app).post('/audit').set('Idempotency-Key', 'auth').send(valid))
        .status,
    ).toBe(403);
    expect((await request(app).post('/audit').send({ secret: 'value' })).status).toBe(
      403,
    );
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed write retryable and does not expose arbitrary service errors', async () => {
    const { app, log } = fixture();
    log.mockImplementationOnce(() => {
      throw new Error('password=secret-token');
    });
    const failed = await request(app)
      .post('/audit')
      .set('Authorization', 'allowed')
      .set('Idempotency-Key', 'retry')
      .send(valid);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain('secret-token');
    const retry = await request(app)
      .post('/audit')
      .set('Authorization', 'allowed')
      .set('Idempotency-Key', 'retry')
      .send(valid);
    expect(retry.status).toBe(201);
    expect(log).toHaveBeenCalledTimes(2);
  });
});
