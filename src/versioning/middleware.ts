/**
 * Versioning Middleware
 * Express middleware for API version extraction and deprecation handling
 */

import { Response, NextFunction } from 'express';
import { VersionedRequest } from './types';
import { extractVersion } from './extractor';
import { getDeprecationInfo, addDeprecationHeaders } from './deprecation';

/**
 * Middleware to extract and attach API version to request
 * Also handles deprecation warnings for deprecated endpoints
 * 
 * @param {VersionedRequest} req - Express request
 * @param {Response} res - Express response
 * @param {NextFunction} next - Express next function
 * 
 * @example
 * app.use(versionMiddleware);
 */
export function versionMiddleware(
  req: VersionedRequest,
  res: Response,
  next: NextFunction
): void {
  // Extract and attach version to request
  req.apiVersion = extractVersion(req);
  
  // Check for deprecation
  const deprecationInfo = getDeprecationInfo(req.method, req.path);
  if (deprecationInfo) {
    addDeprecationHeaders(res, deprecationInfo);
  }
  
  next();
}

/**
 * Middleware to enforce minimum API version
 * Returns 400 if requested version is below minimum
 * 
 * @param {string} minVersion - Minimum required version (e.g., 'v2')
 * @returns {Function} Express middleware function
 * 
 * @example
 * app.use('/api/v2', requireMinVersion('v2'));
 */
export function requireMinVersion(minVersion: string) {
  return (req: VersionedRequest, res: Response, next: NextFunction): void => {
    const requestedVersion = req.apiVersion || 'v1';
    const minVersionNum = parseInt(minVersion.replace('v', ''), 10);
    const requestedVersionNum = parseInt(requestedVersion.replace('v', ''), 10);
    
    if (requestedVersionNum < minVersionNum) {
      res.status(400).json({
        error: 'Version not supported',
        message: `This endpoint requires API version ${minVersion} or higher`,
        requestedVersion,
        minimumVersion: minVersion,
      });
      return;
    }
    
    next();
  };
}
