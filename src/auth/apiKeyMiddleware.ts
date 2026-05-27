/**
 * @module apiKeyMiddleware
 * @description Express middleware for API key authentication.
 *
 * Provides middleware for authenticating requests using API keys.
 * API keys should be provided in the `X-API-Key` header.
 *
 * Usage:
 *   app.get('/api/v1/internal', authenticateApiKey, requireApiKeyScope('contracts', 'read'), handler);
 *
 * Security notes:
 *   - Validates API key against stored hash
 *   - Updates last used timestamp for audit purposes
 *   - Checks for expired keys
 *   - Responds with 401 for missing/invalid keys
 *   - Responds with 403 for insufficient scope
 */

import { Request, Response, NextFunction } from 'express';
import { validateApiKey, ApiKeyInfo } from './apiKeys';
import { authenticateMiddleware } from './authenticate';

/** Express request extended with API key info. */
export interface ApiKeyAuthenticatedRequest extends Request {
  apiKey?: ApiKeyInfo;
}

/**
 * Express middleware that extracts and validates the API key.
 * On success, attaches `req.apiKey` with the key info.
 * On failure, responds with 401.
 */
export function authenticateApiKey(
  req: ApiKeyAuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const apiKey = req.headers['x-api-key'] as string;

  if (!apiKey) {
    res.status(401).json({ error: 'Missing X-API-Key header' });
    return;
  }

  validateApiKey(apiKey)
    .then(keyInfo => {
      if (!keyInfo) {
        res.status(401).json({ error: 'Invalid API key' });
        return;
      }

      req.apiKey = keyInfo;
      next();
    })
    .catch(err => {
      // eslint-disable-next-line no-console
      console.error('API key validation error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
}

/**
 * Factory that returns Express middleware enforcing a specific API key scope.
 *
 * @param resource - The resource being accessed.
 * @param action   - The action being performed.
 * @returns Express middleware function.
 */
export function requireApiKeyScope(resource: string, action: string) {
  return (req: ApiKeyAuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.apiKey) {
      res.status(401).json({ error: 'Not authenticated with API key' });
      return;
    }

    const requiredScope = `${resource}:${action}`;
    const hasScope = req.apiKey.scope.some(scope => {
      // Exact match
      if (scope === requiredScope) return true;
      
      // Wildcard action (e.g., "contracts:*")
      if (scope.endsWith(':*') && scope.startsWith(`${resource}:`)) return true;
      
      // Wildcard resource (e.g., "*:read")
      if (scope.startsWith('*:') && scope.endsWith(`:${action}`)) return true;
      
      // Full wildcard
      if (scope === '*') return true;
      
      return false;
    });

    if (!hasScope) {
      res.status(403).json({ 
        error: 'Forbidden: insufficient API key scope',
        required: requiredScope,
        provided: req.apiKey.scope
      });
      return;
    }

    next();
  };
}

/**
 * Middleware that requires either JWT authentication OR API key authentication.
 * This is useful for endpoints that should be accessible by both users and internal services.
 */
export function authenticateEither(
  req: any, // Using any to support both AuthenticatedRequest and ApiKeyAuthenticatedRequest
  res: Response,
  next: NextFunction,
): void {
  // Check for JWT token first
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    // Let the existing JWT middleware handle this
    return authenticateMiddleware(req, res, next);
  }

  // Check for API key
  const apiKey = req.headers['x-api-key'] as string;
  if (apiKey) {
    return authenticateApiKey(req as ApiKeyAuthenticatedRequest, res, next);
  }

  // Neither authentication method found
  res.status(401).json({ 
    error: 'Authentication required. Provide either Authorization: Bearer <token> or X-API-Key header' 
  });
}
