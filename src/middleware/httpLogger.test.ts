/**
 * Unit tests for src/middleware/httpLogger.ts
 *
 * Coverage targets:
 *   - Access-log record emitted on response finish
 *   - durationMs is a non-negative number
 *   - Uses res.locals.log when available, falls back to root logger
 *   - User-Agent truncation
 *   - IP resolution with and without TRUST_PROXY
 */

import { Request, Response, NextFunction } from 'express';
import { EventEmitter } from 'events';
import { httpLoggerMiddleware } from './httpLogger';
import { Logger } from '../logger';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface FakeRes extends EventEmitter {
  locals: Record<string, unknown>;
  statusCode: number;
}

function makeReqRes(overrides: {
  method?: string;
  originalUrl?: string;
  headers?: Record<string, string>;
  remoteAddress?: string;
  statusCode?: number;
  locals?: Record<string, unknown>;
} = {}): { req: Partial<Request>; res: FakeRes; next: jest.Mock } {
  const res = new EventEmitter() as FakeRes;
  res.locals = overrides.locals ?? {};
  res.statusCode = overrides.statusCode ?? 200;

  const req: Partial<Request> = {
    method: overrides.method ?? 'GET',
    originalUrl: overrides.originalUrl ?? '/health',
    headers: overrides.headers ?? {},
    socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' } as never,
  };

  return { req, res, next: jest.fn() };
}

// ── httpLoggerMiddleware ──────────────────────────────────────────────────────

describe('httpLoggerMiddleware', () => {
  const origEnv = process.env['TRUST_PROXY'];

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['TRUST_PROXY'];
    } else {
      process.env['TRUST_PROXY'] = origEnv;
    }
  });

  it('calls next()', () => {
    const { req, res, next } = makeReqRes();
    httpLoggerMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('emits an info log record on response finish', () => {
    const logged: Array<Record<string, unknown>> = [];
    const mockLog = { info: jest.fn((_msg: string, ctx: Record<string, unknown>) => logged.push(ctx)) };
    const { req, res, next } = makeReqRes({ locals: { log: mockLog } });

    httpLoggerMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    res.emit('finish');

    expect(mockLog.info).toHaveBeenCalledTimes(1);
    expect(mockLog.info).toHaveBeenCalledWith('http request', expect.any(Object));
  });

  it('record includes method, url, statusCode', () => {
    const logged: Array<Record<string, unknown>> = [];
    const mockLog = { info: jest.fn((_msg: string, ctx: Record<string, unknown>) => logged.push(ctx)) };
    const { req, res, next } = makeReqRes({
      method: 'POST',
      originalUrl: '/api/v1/contracts',
      statusCode: 201,
      locals: { log: mockLog },
    });

    httpLoggerMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    res.emit('finish');

    expect(logged[0]!['method']).toBe('POST');
    expect(logged[0]!['url']).toBe('/api/v1/contracts');
    expect(logged[0]!['statusCode']).toBe(201);
  });

  it('record includes a non-negative durationMs', () => {
    const logged: Array<Record<string, unknown>> = [];
    const mockLog = { info: jest.fn((_msg: string, ctx: Record<string, unknown>) => logged.push(ctx)) };
    const { req, res, next } = makeReqRes({ locals: { log: mockLog } });

    httpLoggerMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    res.emit('finish');

    expect(typeof logged[0]!['durationMs']).toBe('number');
    expect(logged[0]!['durationMs'] as number).toBeGreaterThanOrEqual(0);
  });

  it('falls back to root logger when res.locals.log is absent', () => {
    // Spy on the root logger's info method
    const infoSpy = jest.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
    const { req, res, next } = makeReqRes({ locals: {} });

    httpLoggerMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    res.emit('finish');

    expect(infoSpy).toHaveBeenCalledWith('http request', expect.any(Object));
    infoSpy.mockRestore();
  });

  it('truncates User-Agent longer than 256 chars', () => {
    const longUA = 'A'.repeat(300);
    const logged: Array<Record<string, unknown>> = [];
    const mockLog = { info: jest.fn((_msg: string, ctx: Record<string, unknown>) => logged.push(ctx)) };
    const { req, res, next } = makeReqRes({
      headers: { 'user-agent': longUA },
      locals: { log: mockLog },
    });

    httpLoggerMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    res.emit('finish');

    const ua = logged[0]!['userAgent'] as string;
    expect(ua.length).toBeLessThanOrEqual(260); // 256 + ellipsis char
    expect(ua.endsWith('…')).toBe(true);
  });

  it('uses socket.remoteAddress when TRUST_PROXY is not set', () => {
    delete process.env['TRUST_PROXY'];
    const logged: Array<Record<string, unknown>> = [];
    const mockLog = { info: jest.fn((_msg: string, ctx: Record<string, unknown>) => logged.push(ctx)) };
    const { req, res, next } = makeReqRes({
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '1.2.3.4' },
      locals: { log: mockLog },
    });

    httpLoggerMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    res.emit('finish');

    expect(logged[0]!['ip']).toBe('10.0.0.1');
  });

  it('uses X-Forwarded-For first address when TRUST_PROXY=true', () => {
    process.env['TRUST_PROXY'] = 'true';
    const logged: Array<Record<string, unknown>> = [];
    const mockLog = { info: jest.fn((_msg: string, ctx: Record<string, unknown>) => logged.push(ctx)) };
    const { req, res, next } = makeReqRes({
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
      locals: { log: mockLog },
    });

    httpLoggerMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    res.emit('finish');

    expect(logged[0]!['ip']).toBe('1.2.3.4');
  });

  it('falls back to "unknown" when remoteAddress is undefined', () => {
    const logged: Array<Record<string, unknown>> = [];
    const mockLog = { info: jest.fn((_msg: string, ctx: Record<string, unknown>) => logged.push(ctx)) };
    const req: Partial<Request> = {
      method: 'GET',
      originalUrl: '/health',
      headers: {},
      socket: { remoteAddress: undefined } as never,
    };
    const res = new EventEmitter() as FakeRes;
    res.locals = { log: mockLog };
    res.statusCode = 200;

    httpLoggerMiddleware(req as Request, res as unknown as Response, jest.fn() as NextFunction);
    res.emit('finish');

    expect(logged[0]!['ip']).toBe('unknown');
  });

  it('falls back to socket address when X-Forwarded-For is absent with TRUST_PROXY=true', () => {
    process.env['TRUST_PROXY'] = 'true';
    const logged: Array<Record<string, unknown>> = [];
    const mockLog = { info: jest.fn((_msg: string, ctx: Record<string, unknown>) => logged.push(ctx)) };
    const { req, res, next } = makeReqRes({
      remoteAddress: '192.168.1.1',
      locals: { log: mockLog },
    });

    httpLoggerMiddleware(req as Request, res as unknown as Response, next as NextFunction);
    res.emit('finish');

    expect(logged[0]!['ip']).toBe('192.168.1.1');
  });
});
