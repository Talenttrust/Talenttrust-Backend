/**
 * API Versioning Types
 * Defines core types for versioned API management
 */

import { Request, Response, NextFunction } from 'express';

/**
 * Supported API versions
 */
export type ApiVersion = 'v1' | 'v2';

/**
 * Deprecation status for an API endpoint
 */
export interface DeprecationInfo {
  /** Version where endpoint is deprecated */
  deprecatedIn: ApiVersion;
  /** Date when deprecation was announced */
  deprecatedAt: Date;
  /** Date when endpoint will be removed */
  sunsetDate: Date;
  /** Replacement endpoint or migration guide */
  replacement?: string;
  /** Additional deprecation notes */
  notes?: string;
}

/**
 * Version-aware request with extracted version info
 */
export interface VersionedRequest extends Request {
  apiVersion?: ApiVersion;
}

/**
 * Middleware function type for versioned routes
 */
export type VersionedMiddleware = (
  req: VersionedRequest,
  res: Response,
  next: NextFunction
) => void | Promise<void>;
