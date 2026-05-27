/**
 * @module apiKeys
 * @description API key authentication utilities for TalentTrust.
 *
 * Provides secure API key generation, validation, and management.
 * API keys are hashed at rest using SHA-256 with a salt.
 *
 * API keys are expected in the `X-API-Key` header:
 *   X-API-Key: <api-key>
 *
 * Security notes:
 *   - API keys are cryptographically generated using random bytes
 *   - Keys are hashed at rest using SHA-256 with a unique salt
 *   - Each key has optional expiration and scoping
 *   - Keys can be rotated and deactivated
 *   - Last usage is tracked for audit purposes
 */

import * as crypto from 'crypto';
import { ApiKey } from '../database/schema';
import { database } from '../database';

export interface ApiKeyInfo {
  id: string;
  name: string;
  scope: string[];
  createdBy: string;
  createdAt: Date;
  expiresAt?: Date;
  isActive: boolean;
}

export interface ApiKeyRequest {
  name: string;
  scope: string[];
  createdBy: string;
  expiresAt?: Date;
}

/**
 * Generates a cryptographically secure API key.
 *
 * @returns A 32-byte hex-encoded API key.
 */
export function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hashes an API key using SHA-256 with a salt.
 *
 * @param apiKey - The plain API key to hash.
 * @returns An object containing the salt and hash.
 */
export function hashApiKey(apiKey: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(apiKey, salt, 10000, 64, 'sha256').toString('hex');
  return { salt, hash };
}

/**
 * Verifies an API key against a stored hash.
 *
 * @param apiKey - The plain API key to verify.
 * @param salt - The salt used when hashing.
 * @param hash - The stored hash to verify against.
 * @returns True if the key is valid, false otherwise.
 */
export function verifyApiKey(apiKey: string, salt: string, hash: string): boolean {
  const verifyHash = crypto.pbkdf2Sync(apiKey, salt, 10000, 64, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(verifyHash));
}

/**
 * Creates a new API key with the given specifications.
 *
 * @param request - The API key creation request.
 * @returns The created API key info and the plain key (only returned once).
 */
export async function createApiKey(request: ApiKeyRequest): Promise<{ apiKey: string; info: ApiKeyInfo }> {
  const apiKey = generateApiKey();
  const { salt, hash } = hashApiKey(apiKey);
  
  // Store salt and hash together in the key_hash field
  const keyHash = `${salt}:${hash}`;
  
  const dbKey = await database.createApiKey({
    name: request.name,
    key_hash: keyHash,
    scope: request.scope,
    created_by: request.createdBy,
    expires_at: request.expiresAt,
    is_active: true
  });

  return {
    apiKey,
    info: {
      id: dbKey.id,
      name: dbKey.name,
      scope: dbKey.scope,
      createdBy: dbKey.created_by,
      createdAt: dbKey.created_at,
      expiresAt: dbKey.expires_at,
      isActive: dbKey.is_active
    }
  };
}

/**
 * Validates an API key and returns the associated key info if valid.
 *
 * @param apiKey - The plain API key to validate.
 * @returns The API key info if valid, null otherwise.
 */
export async function validateApiKey(apiKey: string): Promise<ApiKeyInfo | null> {
  // Hash the provided key to search for it
  // Note: In a real implementation, you'd need to iterate through keys or use an index
  // For this demo, we'll use a simple approach by checking all active keys
  
  const db = await (database as any).loadDatabase();
  const activeKeys = db.api_keys.filter((key: ApiKey) => key.is_active);
  
  for (const dbKey of activeKeys) {
    const [salt, hash] = dbKey.key_hash.split(':');
    
    if (verifyApiKey(apiKey, salt, hash)) {
      // Update last used timestamp
      await database.updateApiKey(dbKey.id, { last_used_at: new Date() });
      
      // Check if key has expired
      if (dbKey.expires_at && new Date() > dbKey.expires_at) {
        await database.deactivateApiKey(dbKey.id);
        return null;
      }
      
      return {
        id: dbKey.id,
        name: dbKey.name,
        scope: dbKey.scope,
        createdBy: dbKey.created_by,
        createdAt: dbKey.created_at,
        expiresAt: dbKey.expires_at,
        isActive: dbKey.is_active
      };
    }
  }
  
  return null;
}

/**
 * Rotates an API key by generating a new key for the same ID.
 *
 * @param keyId - The ID of the key to rotate.
 * @returns The new API key and updated info, or null if key not found.
 */
export async function rotateApiKey(keyId: string): Promise<{ apiKey: string; info: ApiKeyInfo } | null> {
  const existingKey = await database.getApiKeyById(keyId);
  if (!existingKey) {
    return null;
  }

  const newApiKey = generateApiKey();
  const { salt, hash } = hashApiKey(newApiKey);
  const keyHash = `${salt}:${hash}`;
  
  const updatedKey = await database.rotateApiKey(keyId, keyHash);
  
  if (!updatedKey) {
    return null;
  }
  
  return {
    apiKey: newApiKey,
    info: {
      id: updatedKey.id,
      name: updatedKey.name,
      scope: updatedKey.scope,
      createdBy: updatedKey.created_by,
      createdAt: updatedKey.created_at,
      expiresAt: updatedKey.expires_at,
      isActive: updatedKey.is_active
    }
  };
}

/**
 * Deactivates an API key.
 *
 * @param keyId - The ID of the key to deactivate.
 * @returns True if successful, false otherwise.
 */
export async function deactivateApiKey(keyId: string): Promise<boolean> {
  return await database.deactivateApiKey(keyId);
}
