/**
 * @module apiKeys.routes
 * @description Express routes for API key management.
 *
 * These routes are protected by JWT authentication (not API key auth)
 * since they are used to manage API keys themselves.
 */

import { Request, Router } from 'express';
import { authenticateMiddleware } from '../auth/authenticate';
import { requirePermission } from '../auth/middleware';
import { rateLimitConfig } from '../config/rateLimit';
import { createRateLimiter } from '../middleware/rateLimiter';
import {
  createApiKeyController,
  listApiKeysController,
  getApiKeyController,
  rotateApiKeyController,
  deactivateApiKeyController
} from '../controllers/apiKeyController';
import { apiKeysIdempotencyMiddleware } from '../middleware/apiKeysIdempotency';

const router = Router();

/**
 * Scope limits to the presented API key when one is available, otherwise to
 * the client IP. Prefixes keep the two identifier namespaces distinct. Raw
 * identifiers are hashed by RateLimitStore before they are retained.
 */
export function apiKeysRateLimitKey(req: Request): string {
  const apiKeyHeader = req.headers['x-api-key'];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;

  if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
    return `api-key:${apiKey.trim()}`;
  }

  return `ip:${req.ip ?? req.socket?.remoteAddress ?? 'unknown'}`;
}

const apiKeysRateLimiter = createRateLimiter({
  ...rateLimitConfig.apiKeys,
  keyFn: apiKeysRateLimitKey,
});

router.use(apiKeysRateLimiter);

/**
 * @route   POST /api/v1/api-keys
 * @desc    Create a new API key
 * @access  Private (requires JWT authentication)
 * @example
 * // Request
 * POST /api/v1/api-keys
 * {
 *   "name": "Internal Service Key",
 *   "scope": ["contracts:read", "contracts:create"],
 *   "expiresAt": "2024-12-31T23:59:59Z"
 * }
 * 
 * // Response
 * {
 *   "message": "API key created successfully",
 *   "apiKey": "abc123...", // Only returned once
 *   "info": {
 *     "id": "key-id",
 *     "name": "Internal Service Key",
 *     "scope": ["contracts:read", "contracts:create"],
 *     "createdBy": "user-id",
 *     "createdAt": "2024-01-01T00:00:00Z",
 *     "expiresAt": "2024-12-31T23:59:59Z",
 *     "isActive": true,
 *     "callCount": 0
 *   }
 * }
 */
router.post(
  '/api-keys',
  authenticateMiddleware,
  requirePermission('api-keys', 'create'),
  apiKeysIdempotencyMiddleware(),
  createApiKeyController
);

/**
 * @route   GET /api/v1/api-keys
 * @desc    List active API keys for the authenticated user, newest first.
 *          Cursor-paginated via opaque `nextCursor` tokens so results stay
 *          stable across pages even as new keys are created concurrently.
 * @access  Private (requires JWT authentication)
 * @query   limit  - Page size, 1-100 (default 20). Out-of-range values are
 *                   clamped rather than rejected.
 * @query   cursor - Opaque cursor from the previous page's `nextCursor`.
 *                   Omit for the first page. A malformed cursor returns 400.
 * @example
 * // Request
 * GET /api/v1/api-keys?limit=20
 *
 * // Response
 * {
 *   "apiKeys": [
 *     {
 *       "id": "key-id",
 *       "name": "Internal Service Key",
 *       "scope": ["contracts:read", "contracts:create"],
 *       "createdAt": "2024-01-01T00:00:00Z",
 *       "updatedAt": "2024-01-01T00:00:00Z",
 *       "expiresAt": "2024-12-31T23:59:59Z",
 *       "lastUsedAt": "2024-01-15T10:30:00Z",
 *       "callCount": 42,
 *       "isActive": true
 *     }
 *   ],
 *   "total": 1,
 *   "nextCursor": null,
 *   "hasNextPage": false,
 *   "limit": 20
 * }
 */
router.get(
  '/api-keys',
  authenticateMiddleware,
  requirePermission('api-keys', 'read'),
  listApiKeysController
);

/**
 * @route   GET /api/v1/api-keys/:id
 * @desc    Get details of a specific API key
 * @access  Private (requires JWT authentication)
 * @example
 * // Response
 * {
 *   "id": "key-id",
 *   "name": "Internal Service Key",
 *   "scope": ["contracts:read", "contracts:create"],
 *   "createdAt": "2024-01-01T00:00:00Z",
 *   "updatedAt": "2024-01-01T00:00:00Z",
 *   "expiresAt": "2024-12-31T23:59:59Z",
 *   "lastUsedAt": "2024-01-15T10:30:00Z",
 *   "callCount": 42,
 *   "isActive": true
 * }
 */
router.get(
  '/api-keys/:id',
  authenticateMiddleware,
  requirePermission('api-keys', 'read'),
  getApiKeyController
);

/**
 * @route   POST /api/v1/api-keys/:id/rotate
 * @desc    Rotate an existing API key (generate new key, keep same ID)
 * @access  Private (requires JWT authentication)
 * @example
 * // Response
 * {
 *   "message": "API key rotated successfully",
 *   "apiKey": "def456...", // New key - only returned once
 *   "info": {
 *     "id": "key-id",
 *     "name": "Internal Service Key",
 *     "scope": ["contracts:read", "contracts:create"],
 *     "createdBy": "user-id",
 *     "createdAt": "2024-01-01T00:00:00Z",
 *     "updatedAt": "2024-01-15T10:30:00Z",
 *     "expiresAt": "2024-12-31T23:59:59Z",
 *     "isActive": true,
 *     "callCount": 42,
 *     "lastUsedAt": "2024-01-15T10:30:00Z"
 *   }
 * }
 */
router.post(
  '/api-keys/:id/rotate',
  authenticateMiddleware,
  requirePermission('api-keys', 'update'),
  apiKeysIdempotencyMiddleware(),
  rotateApiKeyController
);

/**
 * @route   DELETE /api/v1/api-keys/:id
 * @desc    Deactivate an API key
 * @access  Private (requires JWT authentication)
 * @example
 * // Response
 * {
 *   "message": "API key deactivated successfully"
 * }
 */
router.delete(
  '/api-keys/:id',
  authenticateMiddleware,
  requirePermission('api-keys', 'delete'),
  apiKeysIdempotencyMiddleware(),
  deactivateApiKeyController
);

export default router;
