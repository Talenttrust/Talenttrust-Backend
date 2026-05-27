/**
 * @module apiKeyController
 * @description Controller for API key management operations.
 *
 * Provides endpoints for creating, viewing, rotating, and deactivating API keys.
 * These endpoints should be protected by JWT authentication (not API key auth).
 */

import { Request, Response } from 'express';
import { createApiKey, rotateApiKey, deactivateApiKey } from '../auth/apiKeys';
import { database } from '../database';
import { AuthenticatedRequest } from '../auth/authenticate';

/**
 * Create a new API key.
 * 
 * @route POST /api/v1/api-keys
 * @access Private (requires JWT authentication)
 * @body { name: string, scope: string[], expiresAt?: Date }
 */
export async function createApiKeyController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { name, scope, expiresAt } = req.body;

    // Validate input
    if (!name || !Array.isArray(scope) || scope.length === 0) {
      res.status(400).json({ 
        error: 'Invalid request body',
        required: { name: 'string', scope: 'string[]' }
      });
      return;
    }

    // Validate scope format (resource:action)
    const invalidScopes = scope.filter((s: string) => {
      if (s === '*') return false;
      if (s.endsWith(':*')) {
        const resource = s.slice(0, -2);
        return !resource || !/^[a-z]+$/.test(resource);
      }
      if (s.startsWith('*:')) {
        const action = s.slice(2);
        return !action || !/^[a-z]+$/.test(action);
      }
      const [resource, action] = s.split(':');
      return !resource || !action || !/^[a-z]+$/.test(resource) || !/^[a-z]+$/.test(action);
    });

    if (invalidScopes.length > 0) {
      res.status(400).json({ 
        error: 'Invalid scope format',
        invalidScopes,
        validFormats: ['resource:action', 'resource:*', '*:action', '*']
      });
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const result = await createApiKey({
      name,
      scope,
      createdBy: req.user.userId,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined
    });

    res.status(201).json({
      message: 'API key created successfully',
      apiKey: result.apiKey, // Only returned once
      info: result.info
    });
  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * List API keys for the authenticated user.
 * 
 * @route GET /api/v1/api-keys
 * @access Private (requires JWT authentication)
 */
export async function listApiKeysController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const db = await (database as any).loadDatabase();
    const userKeys = db.api_keys.filter((key: any) => 
      key.created_by === req.user!.userId && key.is_active
    );

    // Remove sensitive data
    const safeKeys = userKeys.map((key: any) => ({
      id: key.id,
      name: key.name,
      scope: key.scope,
      created_at: key.created_at,
      updated_at: key.updated_at,
      expires_at: key.expires_at,
      last_used_at: key.last_used_at,
      is_active: key.is_active
    }));

    res.json({
      apiKeys: safeKeys,
      total: safeKeys.length
    });
  } catch (error) {
    console.error('Error listing API keys:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Rotate an existing API key.
 * 
 * @route POST /api/v1/api-keys/:id/rotate
 * @access Private (requires JWT authentication)
 */
export async function rotateApiKeyController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // First check if the key belongs to the user
    const existingKey = await database.getApiKeyById(id);
    if (!existingKey) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    if (existingKey.created_by !== req.user.userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const result = await rotateApiKey(id);
    if (!result) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    res.json({
      message: 'API key rotated successfully',
      apiKey: result.apiKey, // Only returned once
      info: result.info
    });
  } catch (error) {
    console.error('Error rotating API key:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Deactivate an API key.
 * 
 * @route DELETE /api/v1/api-keys/:id
 * @access Private (requires JWT authentication)
 */
export async function deactivateApiKeyController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // First check if the key belongs to the user
    const existingKey = await database.getApiKeyById(id);
    if (!existingKey) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    if (existingKey.created_by !== req.user.userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const success = await deactivateApiKey(id);
    if (!success) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    res.json({
      message: 'API key deactivated successfully'
    });
  } catch (error) {
    console.error('Error deactivating API key:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get details of a specific API key.
 * 
 * @route GET /api/v1/api-keys/:id
 * @access Private (requires JWT authentication)
 */
export async function getApiKeyController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const apiKey = await database.getApiKeyById(id);
    if (!apiKey) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    if (apiKey.created_by !== req.user.userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Remove sensitive data
    const safeKey = {
      id: apiKey.id,
      name: apiKey.name,
      scope: apiKey.scope,
      created_at: apiKey.created_at,
      updated_at: apiKey.updated_at,
      expires_at: apiKey.expires_at,
      last_used_at: apiKey.last_used_at,
      is_active: apiKey.is_active
    };

    res.json(safeKey);
  } catch (error) {
    console.error('Error getting API key:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
