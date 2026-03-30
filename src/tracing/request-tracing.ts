import type { NextFunction, Request, Response } from 'express';
import { Tracer } from './tracer';

export interface TraceRequest extends Request {
  traceId?: string;
  requestId?: string;
}

export const createRequestTracingMiddleware =
  (tracer: Tracer) =>
  (req: TraceRequest, res: Response, next: NextFunction): void => {
    const traceIdHeader = req.header('x-trace-id');
    const requestIdHeader = req.header('x-request-id');
    const traceId = traceIdHeader || tracer.newTraceId();
    const requestId = requestIdHeader || tracer.newRequestId();

    tracer.withContext(traceId, requestId, () => {
      req.traceId = traceId;
      req.requestId = requestId;
      res.setHeader('x-trace-id', traceId);
      res.setHeader('x-request-id', requestId);

      const requestSpan = tracer.startSpan(`${req.method} ${req.path}`, 'api', {
        method: req.method,
        path: req.path,
      });

      const finalize = (status: 'ok' | 'error'): void => {
        requestSpan.setAttribute('http.status_code', res.statusCode);
        requestSpan.end(status);
      };

      res.once('finish', () => finalize(res.statusCode >= 500 ? 'error' : 'ok'));
      res.once('close', () => {
        if (!res.writableEnded) {
          requestSpan.setAttribute('connection.closed_early', true);
          requestSpan.end('error');
        }
      });

      next();
    });
  };
