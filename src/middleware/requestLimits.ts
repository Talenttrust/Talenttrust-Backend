/**
 * @title Request Limits Middleware
 * @notice Enforces request body size limits and content-type validation
 * @dev Prevents large-payload DoS attacks and ensures proper content-type handling
 */

import { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/appError';

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
}

/**
 * Default configuration with conservative limits
 */
const DEFAULT_CONFIG: Required<RequestLimitsConfig> = {
  maxBodySize: 1024 * 1024, // 1MB
  enforceJsonContentType: true,
  allowedContentTypes: ['application/json'],
  excludePaths: ['/health', '/metrics'],
};

/**
 * Parses configuration from environment variables
 */
function getConfigFromEnv(): RequestLimitsConfig {
  return {
    maxBodySize: process.env.MAX_REQUEST_BODY_SIZE 
      ? parseInt(process.env.MAX_REQUEST_BODY_SIZE, 10) 
      : DEFAULT_CONFIG.maxBodySize,
    enforceJsonContentType: process.env.ENFORCE_JSON_CONTENT_TYPE !== 'false',
    allowedContentTypes: process.env.ALLOWED_CONTENT_TYPES
      ? process.env.ALLOWED_CONTENT_TYPES.split(',').map(ct => ct.trim())
      : DEFAULT_CONFIG.allowedContentTypes,
    excludePaths: process.env.REQUEST_LIMITS_EXCLUDE_PATHS
      ? process.env.REQUEST_LIMITS_EXCLUDE_PATHS.split(',').map(p => p.trim())
      : DEFAULT_CONFIG.excludePaths,
  };
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

    // Check content-length header against size limit
    const contentLength = req.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > finalConfig.maxBodySize) {
      return next(new AppError(
        413,
        'payload_too_large',
        `Request body size ${contentLength} bytes exceeds maximum allowed size of ${finalConfig.maxBodySize} bytes`,
      ));
    }

    // Enforce content-type validation for requests with body
    if (finalConfig.enforceJsonContentType && req.method !== 'GET' && req.method !== 'HEAD') {
      const contentType = req.get('content-type');
      
      if (!validateContentType(contentType, finalConfig.allowedContentTypes)) {
        return next(new AppError(
          415,
          'unsupported_media_type',
          `Content-Type ${contentType || 'missing'} is not allowed. Allowed types: ${finalConfig.allowedContentTypes.join(', ')}`,
        ));
      }
    }

    next();
  };
}

/**
 * Default middleware instance with environment-driven configuration
 */
export const requestLimitsMiddleware = createRequestLimitsMiddleware();
