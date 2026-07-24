/**
 * @module apiKeys.routes
 * @description Express routes for API key management.
 *
 * These routes are protected by JWT authentication (not API key auth)
 * since they are used to manage API keys themselves.
 */

import { Router } from 'express';
import { authenticateMiddleware } from '../auth/authenticate';
import { requirePermission } from '../auth/middleware';
import {
  createApiKeyController,
  listApiKeysController,
  getApiKeyController,
  rotateApiKeyController,
  deactivateApiKeyController
} from '../controllers/apiKeyController';

const router = Router();

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
 *     "isActive": true
 *   }
 * }
 */
router.post(
  '/api-keys',
  authenticateMiddleware,
  requirePermission('api-keys', 'create'),
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
 *     "isActive": true
 *   }
 * }
 */
router.post(
  '/api-keys/:id/rotate',
  authenticateMiddleware,
  requirePermission('api-keys', 'update'),
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
  deactivateApiKeyController
);

export default router;
