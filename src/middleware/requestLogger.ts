/**
 * @module requestLogger
 * @description Express middleware for request correlation and logging.
 *
 * This middleware:
 * - Generates a unique request ID for each incoming request
 * - Extracts correlation ID from headers (if present)
 * - Adds a request-scoped logger to the request object
 * - Logs request start/end with timing information
 * - Ensures correlation IDs flow through all logs
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Logger, createRequestLogger } from '../logger';
import { sanitizeCorrelationId } from '../utils/correlationId';
import { redactHeaders } from '../utils/redact';

// Extend Express Request interface to include our logger
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      correlationId?: string;
      logger?: Logger;
    }
  }
}

// Header names for correlation ID
const CORRELATION_ID_HEADER = 'x-correlation-id';
const REQUEST_ID_HEADER = 'x-request-id';

function firstValidCorrelationId(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const sanitized = sanitizeCorrelationId(value);
    if (sanitized) {
      return sanitized;
    }
  }
  return undefined;
}

function traceparentTraceId(req: Request): string | undefined {
  return req.header('traceparent')?.split('-')[1];
}

/**
 * Express middleware that adds request correlation and logging capabilities.
 * 
 * Features:
 * - Generates unique request ID if not provided in headers
 * - Extracts correlation ID from headers or generates one
 * - Attaches request-scoped logger to request object
 * - Logs request start and completion with timing
 * - Adds correlation headers to response
 */
export function requestLoggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Generate or extract request ID
  const requestId = sanitizeCorrelationId(req.header(REQUEST_ID_HEADER)) || uuidv4();
  
  // Extract or generate correlation ID
  const correlationId =
    firstValidCorrelationId(
      req.header(CORRELATION_ID_HEADER),
      req.header('x-trace-id'),
      req.header('x-request-id'),
      traceparentTraceId(req),
    ) || uuidv4();

  // Store IDs on request object
  req.requestId = requestId;
  req.correlationId = correlationId;

  // Create request-scoped logger
  req.logger = createRequestLogger(requestId, correlationId);

  // Add correlation headers to response for downstream services
  res.setHeader(REQUEST_ID_HEADER, requestId);
  res.setHeader(CORRELATION_ID_HEADER, correlationId);

  // Record request start time
  const startTime = Date.now();

  // Log request start
  req.logger.info('Request started', {
    method: req.method,
    url: req.url,
    userAgent: req.header('user-agent'),
    ip: req.ip || req.connection.remoteAddress,
    headers: redactHeaders(req.headers)
  });

  // Override res.end to log request completion
  const originalEnd = res.end.bind(res);
  res.end = function(chunk?: any, encoding?: any, cb?: any) {
    const duration = Date.now() - startTime;
    
    req.logger?.info('Request completed', {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      headers: redactHeaders(res.getHeaders())
    });

    return originalEnd(chunk, encoding, cb);
  };

  next();
}

/**
 * Factory function to create a request logger middleware with custom options.
 */
export interface RequestLoggerOptions {
  /** Custom header name for correlation ID */
  correlationIdHeader?: string;
  /** Custom header name for request ID */
  requestIdHeader?: string;
  /** Whether to log request body (default: false for security) */
  logBody?: boolean;
  /** Whether to log response body (default: false for security) */
  logResponseBody?: boolean;
}

export function createRequestLoggerMiddleware(options: RequestLoggerOptions = {}) {
  const {
    correlationIdHeader = CORRELATION_ID_HEADER,
    requestIdHeader = REQUEST_ID_HEADER,
    logBody = false,
    logResponseBody = false
  } = options;

  return function requestLoggerMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Generate or extract request ID
    const requestId = sanitizeCorrelationId(req.header(requestIdHeader)) || uuidv4();
    
    // Extract or generate correlation ID
    const correlationId =
      firstValidCorrelationId(
        req.header(correlationIdHeader),
        req.header('x-trace-id'),
        req.header('x-request-id'),
        traceparentTraceId(req),
      ) || uuidv4();

    // Store IDs on request object
    req.requestId = requestId;
    req.correlationId = correlationId;

    // Create request-scoped logger
    req.logger = createRequestLogger(requestId, correlationId);

    // Add correlation headers to response
    res.setHeader(requestIdHeader, requestId);
    res.setHeader(correlationIdHeader, correlationId);

    // Record request start time
    const startTime = Date.now();

    // Prepare log data
    const logData: any = {
      method: req.method,
      url: req.url,
      userAgent: req.header('user-agent'),
      ip: req.ip || req.connection.remoteAddress,
      headers: redactHeaders(req.headers)
    };

    // Add body if enabled (be careful with sensitive data)
    if (logBody && req.body) {
      logData.body = req.body;
    }

    // Log request start
    req.logger.info('Request started', logData);

    // Override res.end to log request completion
    const originalEnd = res.end.bind(res);
    res.end = function(chunk?: any, encoding?: any, cb?: any) {
      const duration = Date.now() - startTime;
      
      const completionLogData: any = {
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        duration: `${duration}ms`,
        headers: redactHeaders(res.getHeaders())
      };

      // Add response body if enabled
      if (logResponseBody && chunk) {
        try {
          completionLogData.responseBody = 
            typeof chunk === 'string' ? chunk.substring(0, 500) : chunk;
        } catch {
          completionLogData.responseBody = '[Unable to serialize]';
        }
      }

      req.logger?.info('Request completed', completionLogData);

      return originalEnd(chunk, encoding, cb);
    };

    next();
  };
}
