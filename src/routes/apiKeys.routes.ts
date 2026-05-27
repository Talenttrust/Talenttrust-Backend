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
 * @desc    List all API keys for the authenticated user
 * @access  Private (requires JWT authentication)
 * @example
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
 *   "total": 1
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
