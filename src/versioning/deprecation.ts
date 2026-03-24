/**
 * Deprecation Management Module
 * Handles endpoint deprecation tracking and warning headers
 */

import { Response } from 'express';
import { DeprecationInfo, ApiVersion } from './types';

/**
 * Registry of deprecated endpoints
 * Key format: "METHOD /path"
 */
const deprecationRegistry = new Map<string, DeprecationInfo>();

/**
 * Register an endpoint as deprecated
 * 
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} path - Endpoint path
 * @param {DeprecationInfo} info - Deprecation details
 * 
 * @example
 * registerDeprecation('GET', '/api/v1/old-endpoint', {
 *   deprecatedIn: 'v1',
 *   deprecatedAt: new Date('2024-01-01'),
 *   sunsetDate: new Date('2024-06-01'),
 *   replacement: '/api/v2/new-endpoint'
 * });
 */
export function registerDeprecation(
  method: string,
  path: string,
  info: DeprecationInfo
): void {
  const key = `${method.toUpperCase()} ${path}`;
  deprecationRegistry.set(key, info);
}

/**
 * Check if an endpoint is deprecated
 * 
 * @param {string} method - HTTP method
 * @param {string} path - Endpoint path
 * @returns {DeprecationInfo | undefined} Deprecation info if deprecated
 */
export function getDeprecationInfo(
  method: string,
  path: string
): DeprecationInfo | undefined {
  const key = `${method.toUpperCase()} ${path}`;
  return deprecationRegistry.get(key);
}

/**
 * Add deprecation warning headers to response
 * Follows RFC 8594 Sunset HTTP Header standard
 * 
 * @param {Response} res - Express response object
 * @param {DeprecationInfo} info - Deprecation information
 */
export function addDeprecationHeaders(
  res: Response,
  info: DeprecationInfo
): void {
  // Deprecation header (draft standard)
  res.setHeader('Deprecation', 'true');
  
  // Sunset header (RFC 8594)
  res.setHeader('Sunset', info.sunsetDate.toUTCString());
  
  // Link header for replacement endpoint
  if (info.replacement) {
    res.setHeader('Link', `<${info.replacement}>; rel="successor-version"`);
  }
  
  // Custom warning header with details
  const warningMessage = buildWarningMessage(info);
  res.setHeader('X-API-Deprecation-Warning', warningMessage);
}

/**
 * Build human-readable deprecation warning message
 * 
 * @param {DeprecationInfo} info - Deprecation information
 * @returns {string} Warning message
 */
function buildWarningMessage(info: DeprecationInfo): string {
  const parts = [
    `This endpoint is deprecated as of ${info.deprecatedAt.toISOString().split('T')[0]}`,
    `and will be removed on ${info.sunsetDate.toISOString().split('T')[0]}`,
  ];
  
  if (info.replacement) {
    parts.push(`Please migrate to ${info.replacement}`);
  }
  
  if (info.notes) {
    parts.push(info.notes);
  }
  
  return parts.join('. ') + '.';
}

/**
 * Clear all deprecation registrations (useful for testing)
 */
export function clearDeprecationRegistry(): void {
  deprecationRegistry.clear();
}

/**
 * Get all registered deprecations
 * @returns {Map<string, DeprecationInfo>} Complete deprecation registry
 */
export function getAllDeprecations(): Map<string, DeprecationInfo> {
  return new Map(deprecationRegistry);
}
