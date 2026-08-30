import { Request, Response, NextFunction } from 'express';
import { createPayoutIdempotencyMiddleware, payoutIdempotencyStore, PAYOUT_IDEMPOTENCY_TTL_MS } from './payoutIdempotency';

describe('Payout Idempotency Middleware', () => {
  let req: any;
  let res: any;
  let next: jest.Mock;
  let middleware: any;

  beforeEach(() => {
    payoutIdempotencyStore.clear();
    middleware = createPayoutIdempotencyMiddleware();
    next = jest.fn();
    req = {
      headers: { 'idempotency-key': 'key-123' },
      method: 'POST',
      originalUrl: '/api/v1/contracts/c1/milestones/m1/payout',
      params: { milestoneId: 'm1' },
      body: { some: 'data' },
      user: { id: 'tenant-1' }
    };
    res = {
      locals: { requestId: 'req-1' },
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
      statusCode: 200,
    };
  });

  it('same key same body replays response', () => {
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();

    // simulate controller finishing
    res.json({ id: 'pi_1' });

    // 2nd request
    const req2 = { ...req };
    const res2 = {
      locals: { requestId: 'req-2' },
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next2 = jest.fn();

    middleware(req2, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true');
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(res2.json).toHaveBeenCalledWith({ id: 'pi_1' });
  });

  it('same key different body returns 409', () => {
    middleware(req, res, next);
    res.json({ id: 'pi_1' });

    const req2 = { ...req, body: { some: 'other_data' } };
    const res2 = {
      locals: { requestId: 'req-2' },
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    middleware(req2, res2, jest.fn());

    expect(res2.status).toHaveBeenCalledWith(409);
    expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'idempotency_conflict' })
    }));
  });

  it('key reused for another tenant does not conflict', () => {
    middleware(req, res, next);
    res.json({ id: 'pi_1' });

    const req2 = { ...req, user: { id: 'tenant-2' } };
    const res2 = {
      locals: { requestId: 'req-2' },
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      statusCode: 200,
    };
    const next2 = jest.fn();
    middleware(req2, res2, next2);

    expect(next2).toHaveBeenCalled();
  });

  it('concurrent requests returns 409 request_in_progress', () => {
    middleware(req, res, next);
    // controller has not finished (res.json not called)

    const req2 = { ...req };
    const res2 = {
      locals: { requestId: 'req-2' },
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next2 = jest.fn();

    middleware(req2, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.status).toHaveBeenCalledWith(409);
    expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'request_in_progress' })
    }));
  });

  it('expired key is treated as fresh', () => {
    // using custom store with short TTL
    let currentTime = 1000;
    const store = new (require('./contractIdempotencyStore').InMemoryContractIdempotencyStore)({
      ttlMs: 10,
      clock: () => currentTime
    });
    const mw = createPayoutIdempotencyMiddleware({ store, ttlMs: 10 });

    mw(req, res, next);
    res.json({ id: 'pi_1' });

    // advance time beyond TTL
    currentTime += 20;

    const req2 = { ...req };
    const res2 = {
      locals: { requestId: 'req-2' },
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      statusCode: 200,
    };
    const next2 = jest.fn();

    mw(req2, res2, next2);
    expect(next2).toHaveBeenCalled();
  });
});

