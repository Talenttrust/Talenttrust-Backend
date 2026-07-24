/**
 * @module apiKeyController.test
 * @description Integration tests for API key controller endpoints.
 */

import request from 'supertest';
import { createApp } from '../../app';
import { createToken } from '../../auth/authenticate';
import { database } from '../../database';

describe('API Key Controller', () => {
  let app: any;
  let userToken: string;

  beforeEach(async () => {
    await database.clearDatabase();
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

    it('should return 404 for non-existent key', async () => {
      const response = await request(app)
        .get('/api/v1/api-keys/non-existent')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(404);
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

    it('should return 404 for non-existent key', async () => {
      const response = await request(app)
        .post('/api/v1/api-keys/non-existent/rotate')
        .set('Authorization', `Bearer ${userToken}`)
        .send({});

      expect(response.status).toBe(404);
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

    it('should return 404 for non-existent key', async () => {
      const response = await request(app)
        .delete('/api/v1/api-keys/non-existent')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(404);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .delete(`/api/v1/api-keys/${keyId}`);

      expect(response.status).toBe(401);
    });
  });
});
