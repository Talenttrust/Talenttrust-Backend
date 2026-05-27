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
  const requestId = req.header(REQUEST_ID_HEADER) || uuidv4();
  
  // Extract or generate correlation ID
  let correlationId = req.header(CORRELATION_ID_HEADER);
  if (!correlationId) {
    // Try to extract from other common headers
    correlationId = 
      req.header('x-trace-id') ||
      req.header('x-request-id') ||
      req.header('traceparent')?.split('-')[1] || // Extract from W3C traceparent
      uuidv4();
  }

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
    headers: sanitizeHeaders(req.headers)
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
      headers: sanitizeHeaders(res.getHeaders())
    });

    return originalEnd(chunk, encoding, cb);
  };

  next();
}

/**
 * Sanitize headers to remove sensitive information before logging.
 */
function sanitizeHeaders(headers: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  const sensitiveHeaders = [
    'authorization',
    'cookie',
    'x-api-key',
    'x-auth-token',
    'x-forwarded-for',
    'x-real-ip'
  ];

  for (const [key, value] of Object.entries(headers)) {
    if (sensitiveHeaders.includes(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > 200) {
      // Truncate very long header values
      sanitized[key] = value.substring(0, 200) + '...';
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
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
    const requestId = req.header(requestIdHeader) || uuidv4();
    
    // Extract or generate correlation ID
    let correlationId = req.header(correlationIdHeader);
    if (!correlationId) {
      correlationId = 
        req.header('x-trace-id') ||
        req.header('x-request-id') ||
        req.header('traceparent')?.split('-')[1] ||
        uuidv4();
    }

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
      headers: sanitizeHeaders(req.headers)
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
        headers: sanitizeHeaders(res.getHeaders())
      };

      // Add response body if enabled
      if (logResponseBody && chunk) {
        try {
          completionLogData.responseBody = 
            typeof chunk === 'string' ? chunk.substring(0, 500) : chunk;
        } catch (e) {
          completionLogData.responseBody = '[Unable to serialize]';
        }
      }

      req.logger?.info('Request completed', completionLogData);

      return originalEnd(chunk, encoding, cb);
    };

    next();
  };
}
