import { Request, Response, NextFunction } from 'express';
import { requestContext, getRequestContext } from './requestContext';

function makeReqRes(headers: Record<string, string> = {}): {
  req: Partial<Request>;
  res: {
    locals: Record<string, unknown>;
    setHeader: jest.Mock;
  };
  next: jest.Mock;
} {
  const lowercaseHeaders = Object.keys(headers).reduce((acc, key) => {
    acc[key.toLowerCase()] = headers[key];
    return acc;
  }, {} as Record<string, string>);

  return {
    req: {
      header: (name: string) => lowercaseHeaders[name.toLowerCase()] || undefined,
      headers,
    } as unknown as Partial<Request>,
    res: {
      locals: {},
      setHeader: jest.fn(),
    } as unknown as { locals: Record<string, unknown>; setHeader: jest.Mock },
    next: jest.fn(),
  };
}

describe('requestContext middleware', () => {
  it('calls next() and sets res.locals.requestId / header', () => {
    const { req, res, next } = makeReqRes();

    let insideContextValue: any = null;
    next.mockImplementation(() => {
      insideContextValue = getRequestContext();
    });

    requestContext(req as Request, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.locals.requestId).toBeDefined();
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', res.locals.requestId);

    // Verify it set the AsyncLocalStorage context
    expect(insideContextValue).toBeDefined();
    expect(insideContextValue.requestId).toBe(res.locals.requestId);
    expect(insideContextValue.correlationId).toBeUndefined();
  });

  it('reuses existing x-request-id and x-correlation-id from headers', () => {
    const customReqId = 'custom-request-123';
    const customCorrId = 'custom-correlation-456';
    const { req, res, next } = makeReqRes({
      'x-request-id': customReqId,
      'x-correlation-id': customCorrId,
    });

    let insideContextValue: any = null;
    next.mockImplementation(() => {
      insideContextValue = getRequestContext();
    });

    requestContext(req as Request, res as unknown as Response, next as NextFunction);

    expect(res.locals.requestId).toBe(customReqId);
    expect(res.locals.correlationId).toBe(customCorrId);
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', customReqId);
    expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', customCorrId);

    expect(insideContextValue).toEqual({
      requestId: customReqId,
      correlationId: customCorrId,
    });
  });

  it('returns undefined from getRequestContext() outside of request scope', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('does not leak context between concurrent requests', async () => {
    const { req: req1, res: res1, next: next1 } = makeReqRes({
      'x-request-id': 'req-1',
      'x-correlation-id': 'corr-1',
    });
    const { req: req2, res: res2, next: next2 } = makeReqRes({
      'x-request-id': 'req-2',
      'x-correlation-id': 'corr-2',
    });

    const results: any[] = [];

    // Simulate async handler for req1
    next1.mockImplementation(async () => {
      expect(getRequestContext()?.requestId).toBe('req-1');
      expect(getRequestContext()?.correlationId).toBe('corr-1');
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Re-assert context after await boundary
      expect(getRequestContext()?.requestId).toBe('req-1');
      expect(getRequestContext()?.correlationId).toBe('corr-1');
      results.push(getRequestContext());
    });

    // Simulate async handler for req2
    next2.mockImplementation(async () => {
      expect(getRequestContext()?.requestId).toBe('req-2');
      expect(getRequestContext()?.correlationId).toBe('corr-2');
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Re-assert context after await boundary
      expect(getRequestContext()?.requestId).toBe('req-2');
      expect(getRequestContext()?.correlationId).toBe('corr-2');
      results.push(getRequestContext());
    });

    // Trigger both concurrently
    const p1 = new Promise<void>((resolve) => {
      requestContext(req1 as Request, res1 as unknown as Response, async () => {
        await next1();
        resolve();
      });
    });

    const p2 = new Promise<void>((resolve) => {
      requestContext(req2 as Request, res2 as unknown as Response, async () => {
        await next2();
        resolve();
      });
    });

    await Promise.all([p1, p2]);

    expect(results).toHaveLength(2);
    // req2 completes first due to shorter timeout
    expect(results[0]).toEqual({ requestId: 'req-2', correlationId: 'corr-2' });
    expect(results[1]).toEqual({ requestId: 'req-1', correlationId: 'corr-1' });
  });
});
