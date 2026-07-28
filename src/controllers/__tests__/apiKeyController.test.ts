/**
 * @module apiKeyController.test
 * @description Integration tests for API key controller endpoints.
 */

import request from 'supertest';
import { createApp } from '../../app';
import { createToken } from '../../auth/authenticate';
import { database } from '../../database';
import { defaultIdempotencyStore } from '../../db/idempotencyStore';

describe('API Key Controller', () => {
  let app: any;
  let userToken: string;

  beforeEach(async () => {
    await database.clearDatabase();
    defaultIdempotencyStore.clear();
    app = createApp();
    userToken = createToken('test-user', 'admin');
  });

  describe('POST /api/v1/api-keys', () => {
    it('should create a new API key', async () => {
      const response = await request(app)
        .post('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Test API Key',
          scope: ['contracts:read', 'contracts:create']
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('apiKey');
      expect(response.body).toHaveProperty('info');
      expect(response.body.apiKey).toMatch(/^[a-f0-9]{64}$/);
      expect(response.body.info.name).toBe('Test API Key');
      expect(response.body.info.scope).toEqual(['contracts:read', 'contracts:create']);
    });

    it('should validate request body', async () => {
      const response = await request(app)
        .post('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: '',
          scope: []
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid request body');
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/v1/api-keys')
        .send({
          name: 'Test API Key',
          scope: ['contracts:read']
        });

      expect(response.status).toBe(401);
    });

    it('should reject invalid scope format', async () => {
      const response = await request(app)
        .post('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Bad Scope Key',
          scope: ['invalid-scope-format']
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid scope format');
      expect(response.body).toHaveProperty('invalidScopes');
      expect(response.body).toHaveProperty('validFormats');
    });

    it('should create API key with expiration', async () => {
      const expiresAt = new Date('2025-12-31T23:59:59Z').toISOString();
      const response = await request(app)
        .post('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Temporal Key',
          scope: ['contracts:read'],
          expiresAt
        });

      expect(response.status).toBe(201);
      expect(response.body.info.expiresAt).toBeDefined();
      expect(new Date(response.body.info.expiresAt).toISOString()).toBe(expiresAt);
    });

    it('should allow creating multiple keys with the same name (idempotent)', async () => {
      const body = {
        name: 'Repeatable Key',
        scope: ['contracts:read']
      };

      const response1 = await request(app)
        .post('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`)
        .send(body);

      expect(response1.status).toBe(201);

      const response2 = await request(app)
        .post('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`)
        .send(body);

      expect(response2.status).toBe(201);
      expect(response2.body.apiKey).not.toBe(response1.body.apiKey);
    });
  });

  describe('GET /api/v1/api-keys', () => {
    beforeEach(async () => {
      // Create a test API key
      const { createApiKey } = require('../../auth/apiKeys');
      await createApiKey({
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'test-user'
      });
    });

    it('should list user API keys', async () => {
      const response = await request(app)
        .get('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('apiKeys');
      expect(response.body).toHaveProperty('total');
      expect(response.body.apiKeys).toHaveLength(1);
      expect(response.body.apiKeys[0].name).toBe('Test Key');
      expect(response.body.apiKeys[0]).not.toHaveProperty('key_hash'); // Sensitive data removed
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .get('/api/v1/api-keys');

      expect(response.status).toBe(401);
    });

    it('should include pagination metadata on an unfilled first page', async () => {
      const response = await request(app)
        .get('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.hasNextPage).toBe(false);
      expect(response.body.nextCursor).toBeNull();
      expect(response.body.limit).toBe(20);
    });
  });

  describe('GET /api/v1/api-keys — pagination', () => {
    const { createApiKey } = require('../../auth/apiKeys');

    /** Creates `count` sequential keys for `test-user`, oldest first. */
    async function seedKeys(count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        await createApiKey({
          name: `Key ${i}`,
          scope: ['contracts:read'],
          createdBy: 'test-user'
        });
      }
    }

    it('returns an empty page when the user has no keys', async () => {
      const response = await request(app)
        .get('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.apiKeys).toEqual([]);
      expect(response.body.total).toBe(0);
      expect(response.body.hasNextPage).toBe(false);
      expect(response.body.nextCursor).toBeNull();
    });

    it('paginates across pages without duplicates or omissions', async () => {
      await seedKeys(5);

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;

      do {
        const response: any = await request(app)
          .get('/api/v1/api-keys')
          .query({ limit: 2, ...(cursor ? { cursor } : {}) })
          .set('Authorization', `Bearer ${userToken}`);

        expect(response.status).toBe(200);
        expect(response.body.apiKeys.length).toBeLessThanOrEqual(2);
        seen.push(...response.body.apiKeys.map((k: { id: string }) => k.id));
        cursor = response.body.nextCursor ?? undefined;
        pages++;
      } while (cursor && pages < 10);

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5); // no duplicates across pages
    });

    it('returns hasNextPage=false and nextCursor=null exactly at the page boundary', async () => {
      await seedKeys(4);

      const response = await request(app)
        .get('/api/v1/api-keys')
        .query({ limit: 4 })
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.apiKeys).toHaveLength(4);
      expect(response.body.hasNextPage).toBe(false);
      expect(response.body.nextCursor).toBeNull();
    });

    it('clamps an over-limit request to the maximum page size instead of erroring', async () => {
      await seedKeys(3);

      const response = await request(app)
        .get('/api/v1/api-keys')
        .query({ limit: 100000 })
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.limit).toBe(100);
      expect(response.body.apiKeys).toHaveLength(3);
    });

    it('rejects a malformed cursor with 400', async () => {
      const response = await request(app)
        .get('/api/v1/api-keys')
        .query({ cursor: 'not-a-valid-cursor!!!' })
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('rejects a well-formed but tampered cursor payload with 400', async () => {
      const tampered = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');

      const response = await request(app)
        .get('/api/v1/api-keys')
        .query({ cursor: tampered })
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(400);
    });

    it('keeps the owner filter applied across pages (does not leak other users keys)', async () => {
      await seedKeys(2);
      await createApiKey({
        name: 'Other User Key',
        scope: ['contracts:read'],
        createdBy: 'someone-else'
      });

      const response = await request(app)
        .get('/api/v1/api-keys')
        .query({ limit: 10 })
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.apiKeys).toHaveLength(2);
      expect(response.body.apiKeys.every((k: { name: string }) => k.name !== 'Other User Key')).toBe(true);
    });
  });

  describe('GET /api/v1/api-keys/:id', () => {
    let keyId: string;

    beforeEach(async () => {
      const { createApiKey } = require('../../auth/apiKeys');
      const result = await createApiKey({
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'test-user'
      });
      keyId = result.info.id;
    });

    it('should get API key details', async () => {
      const response = await request(app)
        .get(`/api/v1/api-keys/${keyId}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Test Key');
      expect(response.body.scope).toEqual(['contracts:read']);
      expect(response.body).not.toHaveProperty('key_hash'); // Sensitive data removed
    });

    it('should return 404 with error message for non-existent key', async () => {
      const response = await request(app)
        .get('/api/v1/api-keys/non-existent')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'API key not found' });
    });

    it('should return 403 for another user\'s key (access denied)', async () => {
      const otherUserToken = createToken('other-user', 'admin');
      const response = await request(app)
        .get(`/api/v1/api-keys/${keyId}`)
        .set('Authorization', `Bearer ${otherUserToken}`);

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Access denied' });
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .get(`/api/v1/api-keys/${keyId}`);

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/v1/api-keys/:id/rotate', () => {
    let keyId: string;

    beforeEach(async () => {
      const { createApiKey } = require('../../auth/apiKeys');
      const result = await createApiKey({
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'test-user'
      });
      keyId = result.info.id;
    });

    it('should rotate API key', async () => {
      const response = await request(app)
        .post(`/api/v1/api-keys/${keyId}/rotate`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('apiKey');
      expect(response.body).toHaveProperty('info');
      expect(response.body.apiKey).toMatch(/^[a-f0-9]{64}$/);
      expect(response.body.apiKey).not.toBe(keyId); // New key should be different
    });

    it('should return 404 with error message for non-existent key', async () => {
      const response = await request(app)
        .post('/api/v1/api-keys/non-existent/rotate')
        .set('Authorization', `Bearer ${userToken}`)
        .send({});

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'API key not found' });
    });

    it('should return 403 for another user\'s key (access denied)', async () => {
      const otherUserToken = createToken('other-user', 'admin');
      const response = await request(app)
        .post(`/api/v1/api-keys/${keyId}/rotate`)
        .set('Authorization', `Bearer ${otherUserToken}`)
        .send({});

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Access denied' });
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post(`/api/v1/api-keys/${keyId}/rotate`)
        .send({});

      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/api-keys/:id', () => {
    let keyId: string;

    beforeEach(async () => {
      const { createApiKey } = require('../../auth/apiKeys');
      const result = await createApiKey({
        name: 'Test Key',
        scope: ['contracts:read'],
        createdBy: 'test-user'
      });
      keyId = result.info.id;
    });

    it('should deactivate API key', async () => {
      const response = await request(app)
        .delete(`/api/v1/api-keys/${keyId}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('API key deactivated successfully');
    });

    it('should return 404 with error message for non-existent key', async () => {
      const response = await request(app)
        .delete('/api/v1/api-keys/non-existent')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'API key not found' });
    });

    it('should return 403 for another user\'s key (access denied)', async () => {
      const otherUserToken = createToken('other-user', 'admin');
      const response = await request(app)
        .delete(`/api/v1/api-keys/${keyId}`)
        .set('Authorization', `Bearer ${otherUserToken}`);

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Access denied' });
    });

    it('should return 404 for an already-deactivated key (idempotent-repeat)', async () => {
      const response = await request(app)
        .delete(`/api/v1/api-keys/${keyId}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);

      // Second deactivation should return 404 since key is no longer active
      const secondResponse = await request(app)
        .delete(`/api/v1/api-keys/${keyId}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(secondResponse.status).toBe(404);
      expect(secondResponse.body).toEqual({ error: 'API key not found' });
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .delete(`/api/v1/api-keys/${keyId}`);

      expect(response.status).toBe(401);
    });
  });

  describe('Idempotency-Key support', () => {
    it('creates an API key on the first write', async () => {
      const response = await request(app)
        .post('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`)
        .set('Idempotency-Key', 'idempotency-create-1')
        .send({
          name: 'Idempotent Key',
          scope: ['contracts:read'],
        });

      expect(response.status).toBe(201);
      expect(response.body.apiKey).toMatch(/^[a-f0-9]{64}$/);
      expect(response.body.info.name).toBe('Idempotent Key');
    });

    it('replays the original response on an exact retry', async () => {
      const payload = {
        name: 'Idempotent Key',
        scope: ['contracts:read'],
      };

      const first = await request(app)
        .post('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`)
        .set('Idempotency-Key', 'idempotency-create-2')
        .send(payload);

      const replay = await request(app)
        .post('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`)
        .set('Idempotency-Key', 'idempotency-create-2')
        .send(payload);

      expect(replay.status).toBe(first.status);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['idempotency-replayed']).toBe('true');
    });

    it('returns 409 when the key is reused with a different body', async () => {
      await request(app)
        .post('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`)
        .set('Idempotency-Key', 'idempotency-conflict')
        .send({
          name: 'First',
          scope: ['contracts:read'],
        });

      const conflict = await request(app)
        .post('/api/v1/api-keys')
        .set('Authorization', `Bearer ${userToken}`)
        .set('Idempotency-Key', 'idempotency-conflict')
        .send({
          name: 'Second',
          scope: ['contracts:read'],
        });

      expect(conflict.status).toBe(409);
      expect(conflict.body.error?.code).toBe('conflict');
    });
  });
});

// ─── Unit tests: validateApiKeyRequestBody ────────────────────────────────────
//
// These tests exercise the pure validation function directly so every branch
// is covered without spinning up the HTTP stack.

describe('validateApiKeyRequestBody', () => {
  // ── valid inputs ───────────────────────────────────────────────────────────

  it('returns null for a minimal valid body', () => {
    expect(validateApiKeyRequestBody({ name: 'My Key', scope: ['contracts:read'] })).toBeNull();
  });

  it('returns null when expiresAt is a valid ISO-8601 string', () => {
    expect(
      validateApiKeyRequestBody({
        name: 'Key',
        scope: ['contracts:read'],
        expiresAt: '2030-01-01T00:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('returns null for all supported scope wildcard formats', () => {
    expect(validateApiKeyRequestBody({ name: 'K', scope: ['*'] })).toBeNull();
    expect(validateApiKeyRequestBody({ name: 'K', scope: ['contracts:*'] })).toBeNull();
    expect(validateApiKeyRequestBody({ name: 'K', scope: ['*:read'] })).toBeNull();
    expect(validateApiKeyRequestBody({ name: 'K', scope: ['contracts:read', 'users:write'] })).toBeNull();
  });

  it('returns null for a name exactly at the 100-character limit', () => {
    expect(validateApiKeyRequestBody({ name: 'a'.repeat(100), scope: ['contracts:read'] })).toBeNull();
  });

  it('returns null for a scope array with exactly 20 items', () => {
    const scope = Array.from({ length: 20 }, (_, i) => `resource${i}:read`);
    expect(validateApiKeyRequestBody({ name: 'Key', scope })).toBeNull();
  });

  // ── non-object bodies ──────────────────────────────────────────────────────

  it('returns MISSING_FIELDS for a null body', () => {
    const err = validateApiKeyRequestBody(null);
    expect(err).not.toBeNull();
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS for an array body', () => {
    const err = validateApiKeyRequestBody([{ name: 'k', scope: ['x:y'] }]);
    expect(err).not.toBeNull();
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS for a primitive body', () => {
    const err = validateApiKeyRequestBody('just a string');
    expect(err).not.toBeNull();
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  // ── unknown fields ─────────────────────────────────────────────────────────

  it('returns UNKNOWN_FIELDS when body contains an extra field', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['x:y'], isAdmin: true });
    expect(err).not.toBeNull();
    expect(err!['code']).toBe('UNKNOWN_FIELDS');
    expect((err!['unknownFields'] as string[])).toContain('isAdmin');
  });

  it('returns UNKNOWN_FIELDS for multiple unknown fields', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['x:y'], foo: 1, bar: 2 });
    expect(err!['code']).toBe('UNKNOWN_FIELDS');
    expect((err!['unknownFields'] as string[]).sort()).toEqual(['bar', 'foo']);
  });

  // ── name field ─────────────────────────────────────────────────────────────

  it('returns MISSING_FIELDS when name is absent', () => {
    const err = validateApiKeyRequestBody({ scope: ['contracts:read'] });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when name is an empty string', () => {
    const err = validateApiKeyRequestBody({ name: '', scope: ['contracts:read'] });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when name is whitespace-only', () => {
    const err = validateApiKeyRequestBody({ name: '   ', scope: ['contracts:read'] });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when name is a number', () => {
    const err = validateApiKeyRequestBody({ name: 42, scope: ['contracts:read'] });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when name is null', () => {
    const err = validateApiKeyRequestBody({ name: null, scope: ['contracts:read'] });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns OUT_OF_RANGE when name exceeds 100 characters', () => {
    const err = validateApiKeyRequestBody({ name: 'a'.repeat(101), scope: ['contracts:read'] });
    expect(err!['code']).toBe('OUT_OF_RANGE');
    expect(err!['maxLength']).toBe(100);
    expect(err!['received']).toBe(101);
  });

  // ── scope field ────────────────────────────────────────────────────────────

  it('returns MISSING_FIELDS when scope is absent', () => {
    const err = validateApiKeyRequestBody({ name: 'Key' });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when scope is an empty array', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: [] });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when scope is not an array', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: 'contracts:read' });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when scope contains a non-string item', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['contracts:read', 42] });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns MISSING_FIELDS when scope is null', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: null });
    expect(err!['code']).toBe('MISSING_FIELDS');
  });

  it('returns OUT_OF_RANGE when scope has more than 20 items', () => {
    const scope = Array.from({ length: 21 }, (_, i) => `resource${i}:read`);
    const err = validateApiKeyRequestBody({ name: 'Key', scope });
    expect(err!['code']).toBe('OUT_OF_RANGE');
    expect(err!['maxItems']).toBe(20);
    expect(err!['received']).toBe(21);
  });

  it('returns OUT_OF_RANGE when a scope item exceeds 64 characters', () => {
    const longItem = 'a'.repeat(65);
    const err = validateApiKeyRequestBody({ name: 'Key', scope: [longItem] });
    expect(err!['code']).toBe('OUT_OF_RANGE');
    expect((err!['oversizedItems'] as string[])).toContain(longItem);
  });

  it('returns INVALID_SCOPE for a scope item with wrong format', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['BAD_FORMAT'] });
    expect(err!['code']).toBe('INVALID_SCOPE');
    expect((err!['invalidScopes'] as string[])).toContain('BAD_FORMAT');
  });

  it('returns INVALID_SCOPE for a scope item with uppercase characters', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['Contracts:Read'] });
    expect(err!['code']).toBe('INVALID_SCOPE');
  });

  it('returns INVALID_SCOPE for a scope item with extra colons', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['a:b:c'] });
    expect(err!['code']).toBe('INVALID_SCOPE');
  });

  it('returns INVALID_SCOPE for an empty-resource scope', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: [':read'] });
    expect(err!['code']).toBe('INVALID_SCOPE');
  });

  it('returns INVALID_SCOPE for an empty-action scope', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['contracts:'] });
    expect(err!['code']).toBe('INVALID_SCOPE');
  });

  // ── expiresAt field ────────────────────────────────────────────────────────

  it('returns INVALID_DATE when expiresAt is a number', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['contracts:read'], expiresAt: 12345 });
    expect(err!['code']).toBe('INVALID_DATE');
  });

  it('returns INVALID_DATE when expiresAt is a non-date string', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['contracts:read'], expiresAt: 'not-a-date' });
    expect(err!['code']).toBe('INVALID_DATE');
  });

  it('returns INVALID_DATE when expiresAt is an empty string', () => {
    const err = validateApiKeyRequestBody({ name: 'Key', scope: ['contracts:read'], expiresAt: '' });
    expect(err!['code']).toBe('INVALID_DATE');
  });
});

// ─── Integration: input validation via HTTP ───────────────────────────────────

describe('POST /api/v1/api-keys – input validation (HTTP)', () => {
  let app: any;
  let userToken: string;

  beforeEach(async () => {
    await database.clearDatabase();
    app = createApp();
    userToken = createToken('test-user', 'admin');
  });

  const post = (body: unknown) =>
    request(app)
      .post('/api/v1/api-keys')
      .set('Authorization', `Bearer ${userToken}`)
      .send(body as object);

  it('returns 400 with code UNKNOWN_FIELDS for an unknown field', async () => {
    const res = await post({ name: 'K', scope: ['x:y'], isAdmin: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_FIELDS');
    expect(res.body.unknownFields).toContain('isAdmin');
  });

  it('returns 400 with code MISSING_FIELDS when name is absent', async () => {
    const res = await post({ scope: ['contracts:read'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  it('returns 400 with code MISSING_FIELDS when name is empty', async () => {
    const res = await post({ name: '', scope: ['contracts:read'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  it('returns 400 with code OUT_OF_RANGE when name is too long', async () => {
    const res = await post({ name: 'a'.repeat(101), scope: ['contracts:read'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OUT_OF_RANGE');
    expect(res.body.maxLength).toBe(100);
  });

  it('returns 400 with code MISSING_FIELDS when scope is absent', async () => {
    const res = await post({ name: 'Key' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  it('returns 400 with code MISSING_FIELDS when scope is empty array', async () => {
    const res = await post({ name: 'Key', scope: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  it('returns 400 with code OUT_OF_RANGE when scope has 21 items', async () => {
    const scope = Array.from({ length: 21 }, (_, i) => `resource${i}:read`);
    const res = await post({ name: 'Key', scope });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OUT_OF_RANGE');
    expect(res.body.maxItems).toBe(20);
  });

  it('returns 400 with code OUT_OF_RANGE when a scope item is too long', async () => {
    const res = await post({ name: 'Key', scope: ['a'.repeat(65)] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OUT_OF_RANGE');
  });

  it('returns 400 with code INVALID_SCOPE for a malformed scope item', async () => {
    const res = await post({ name: 'Key', scope: ['BAD_FORMAT'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SCOPE');
    expect(res.body.invalidScopes).toContain('BAD_FORMAT');
    expect(res.body.validFormats).toBeDefined();
  });

  it('returns 400 with code INVALID_DATE for a non-date expiresAt', async () => {
    const res = await post({ name: 'Key', scope: ['contracts:read'], expiresAt: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  it('accepts a boundary name of exactly 100 characters', async () => {
    const res = await post({ name: 'a'.repeat(100), scope: ['contracts:read'] });
    expect(res.status).toBe(201);
  });

  it('accepts exactly 20 scope items', async () => {
    const scope = Array.from({ length: 20 }, (_, i) => `resource${i}:read`);
    const res = await post({ name: 'Key', scope });
    expect(res.status).toBe(201);
  });

  it('accepts a valid expiresAt ISO-8601 string', async () => {
    const res = await post({ name: 'Key', scope: ['contracts:read'], expiresAt: '2099-12-31T23:59:59.000Z' });
    expect(res.status).toBe(201);
    expect(res.body.info.expiresAt).toBeDefined();
  });

  it('does not echo raw secrets in error responses', async () => {
    const secret = 'super-secret-value';
    const res = await post({ name: 'Key', scope: ['contracts:read'], [secret]: true });
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });
});
