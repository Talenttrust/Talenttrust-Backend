/**
 * Version Extraction Module
 * Extracts API version from request URL, headers, or query parameters
 */

import { Request } from 'express';
import { ApiVersion } from './types';

/**
 * Extract API version from request
 * Priority: URL path > Accept header > Query param > Default (v1)
 * 
 * @param {Request} req - Express request object
 * @returns {ApiVersion} Extracted API version
 * 
 * @example
 * // URL-based: /api/v1/contracts
 * extractVersion(req) // returns 'v1'
 * 
 * // Header-based: Accept: application/vnd.talenttrust.v2+json
 * extractVersion(req) // returns 'v2'
 */
export function extractVersion(req: Request): ApiVersion {
  // 1. Check URL path (e.g., /api/v1/contracts)
  const pathMatch = req.path.match(/\/api\/(v\d+)\//);
  if (pathMatch && isValidVersion(pathMatch[1])) {
    return pathMatch[1] as ApiVersion;
  }

  // 2. Check Accept header (e.g., application/vnd.talenttrust.v2+json)
  const acceptHeader = req.get('Accept');
  if (acceptHeader) {
    const headerMatch = acceptHeader.match(/vnd\.talenttrust\.(v\d+)/);
    if (headerMatch && isValidVersion(headerMatch[1])) {
      return headerMatch[1] as ApiVersion;
    }
  }

  // 3. Check query parameter (e.g., ?version=v2)
  const queryVersion = req.query.version as string;
  if (queryVersion && isValidVersion(queryVersion)) {
    return queryVersion as ApiVersion;
  }

  // 4. Default to v1
  return 'v1';
}

/**
 * Validate if a string is a supported API version
 * 
 * @param {string} version - Version string to validate
 * @returns {boolean} True if version is supported
 */
export function isValidVersion(version: string): boolean {
  return ['v1', 'v2'].includes(version);
}
