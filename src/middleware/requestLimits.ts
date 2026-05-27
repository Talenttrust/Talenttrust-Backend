/**
 * @title Request Limits Middleware
 * @notice Enforces request body size limits and content-type validation
 * @dev Prevents large-payload DoS attacks and ensures proper content-type handling
 */

import { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/appError';
import { validateEnv } from '../config/env.schema';

/**
 * Configuration for request limits
 */
export interface RequestLimitsConfig {
  /** Maximum request body size in bytes (default: 1MB) */
  maxBodySize?: number;
  /** Whether to enforce JSON content-type (default: true) */
  enforceJsonContentType?: boolean;
  /** Content types that are allowed (default: ['application/json']) */
  allowedContentTypes?: string[];
  /** Paths to exclude from content-type enforcement */
  excludePaths?: string[];
  /** Dynamic route-specific body size limits mapping */
  routeBodyLimits?: Record<string, number>;
}

/**
 * Default configuration with conservative limits
 */
const DEFAULT_CONFIG: Required<RequestLimitsConfig> = {
  maxBodySize: 1024 * 1024, // 1MB
  enforceJsonContentType: true,
  allowedContentTypes: ['application/json'],
  excludePaths: ['/health', '/metrics'],
  routeBodyLimits: {},
};

/**
 * Parses configuration from environment variables
 */
function getConfigFromEnv(): RequestLimitsConfig {
  try {
    const env = validateEnv();
    return {
      maxBodySize: env.MAX_REQUEST_BODY_SIZE ?? DEFAULT_CONFIG.maxBodySize,
      enforceJsonContentType: env.ENFORCE_JSON_CONTENT_TYPE ?? DEFAULT_CONFIG.enforceJsonContentType,
      allowedContentTypes: env.ALLOWED_CONTENT_TYPES ?? DEFAULT_CONFIG.allowedContentTypes,
      excludePaths: env.REQUEST_LIMITS_EXCLUDE_PATHS ?? DEFAULT_CONFIG.excludePaths,
      routeBodyLimits: env.ROUTE_BODY_LIMITS ?? DEFAULT_CONFIG.routeBodyLimits,
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Validates content type against allowed types
 */
function validateContentType(
  contentType: string | undefined,
  allowedTypes: string[],
): boolean {
  if (!contentType) return false;
  
  // Extract the media type (ignore charset and other parameters)
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  
  return allowedTypes.some(allowedType => 
    allowedType.toLowerCase() === mediaType
  );
}

/**
 * Checks if a path should be excluded from validation
 */
function shouldExcludePath(reqPath: string, excludePaths: string[]): boolean {
  return excludePaths.some(path => reqPath.startsWith(path));
}

/**
 * Creates middleware for request body size and content-type validation
 */
export function createRequestLimitsMiddleware(config: RequestLimitsConfig = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...getConfigFromEnv(), ...config };

  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip validation for excluded paths
    if (shouldExcludePath(req.path, finalConfig.excludePaths)) {
      return next();
    }

    // Determine the limit for this route
    let limit = finalConfig.maxBodySize;
    if (finalConfig.routeBodyLimits) {
      // Sort keys by length descending to match most specific route first
      const sortedRoutes = Object.keys(finalConfig.routeBodyLimits).sort((a, b) => b.length - a.length);
      for (const route of sortedRoutes) {
        if (req.path === route || req.path.startsWith(route + '/')) {
          limit = finalConfig.routeBodyLimits[route];
          break;
        }
      }
    }

    // 1. Enforce content-type validation for requests with body (non-GET, non-HEAD)
    if (finalConfig.enforceJsonContentType && req.method !== 'GET' && req.method !== 'HEAD') {
      const contentType = req.get('content-type');
      const hasBody = req.get('content-length') !== undefined || req.get('transfer-encoding') !== undefined;
      
      if (hasBody && !validateContentType(contentType, finalConfig.allowedContentTypes)) {
        return next(new AppError(
          415,
          'unsupported_media_type',
          `Content-Type ${contentType || 'missing'} is not allowed. Allowed types: ${finalConfig.allowedContentTypes.join(', ')}`,
        ));
      }
    }

    // 2. Check content-length header against size limit
    const contentLengthStr = req.get('content-length');
    if (contentLengthStr) {
      const contentLength = parseInt(contentLengthStr, 10);
      if (Number.isNaN(contentLength) || contentLength > limit) {
        return next(new AppError(
          413,
          'payload_too_large',
          'Payload Too Large'
        ));
      }
    }

    // 3. Monitor streaming body byte count for chunked uploads or header tampering
    let bytesRead = 0;
    let limitExceeded = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };

    const onData = (chunk: Buffer) => {
      if (limitExceeded) return;
      bytesRead += chunk.length;
      if (bytesRead > limit) {
        limitExceeded = true;
        cleanup();
        
        // Track the error so it can be handled by the global error handler
        (req as any).streamError = new AppError(413, 'payload_too_large', 'Payload Too Large');
        
        // Destroy request stream to halt upload
        req.destroy();
      }
    };

    const onEnd = () => cleanup();
    const onError = () => cleanup();
    const onClose = () => cleanup();

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);

    next();
  };
}

/**
 * Default middleware instance with environment-driven configuration
 */
export const requestLimitsMiddleware = createRequestLimitsMiddleware();
