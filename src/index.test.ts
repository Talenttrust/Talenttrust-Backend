/**
 * Integration Tests for TalentTrust API
 * End-to-end tests for versioned API endpoints
 */

import request from 'supertest';
import app from './app';

describe('TalentTrust API Integration Tests', () => {
  describe('Application Export', () => {
    it('should export Express application', () => {
      expect(app).toBeDefined();
      expect(typeof app).toBe('function');
    });
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('service', 'talenttrust-backend');
      expect(response.body).toHaveProperty('version');
      expect(response.body).toHaveProperty('timestamp');
    });
  });

  describe('API v1 Endpoints', () => {
    describe('GET /api/v1/contracts', () => {
      it('should return contracts list', async () => {
        const response = await request(app).get('/api/v1/contracts');

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('version', 'v1');
        expect(response.body).toHaveProperty('contracts');
        expect(Array.isArray(response.body.contracts)).toBe(true);
      });

      it('should include deprecation headers', async () => {
        const response = await request(app).get('/api/v1/contracts');

        expect(response.headers).toHaveProperty('deprecation', 'true');
        expect(response.headers).toHaveProperty('sunset');
        expect(response.headers).toHaveProperty('link');
        expect(response.headers).toHaveProperty('x-api-deprecation-warning');
      });

      it('should suggest v2 replacement in Link header', async () => {
        const response = await request(app).get('/api/v1/contracts');

        expect(response.headers.link).toContain('/api/v2/contracts');
        expect(response.headers.link).toContain('successor-version');
      });
    });

    describe('GET /api/v1/contracts/:id', () => {
      it('should return contract by ID', async () => {
        const response = await request(app).get('/api/v1/contracts/test-123');

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('version', 'v1');
        expect(response.body).toHaveProperty('contract');
        expect(response.body.contract).toHaveProperty('id', 'test-123');
        expect(response.body.contract).toHaveProperty('status');
        expect(response.body.contract).toHaveProperty('createdAt');
      });
    });
  });

  describe('API v2 Endpoints', () => {
    describe('GET /api/v2/contracts', () => {
      it('should return enhanced contracts list', async () => {
        const response = await request(app).get('/api/v2/contracts');

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('version', 'v2');
        expect(response.body).toHaveProperty('contracts');
        expect(response.body).toHaveProperty('pagination');
        expect(Array.isArray(response.body.contracts)).toBe(true);
      });

      it('should support pagination parameters', async () => {
        const response = await request(app)
          .get('/api/v2/contracts')
          .query({ limit: 20 });

        expect(response.status).toBe(200);
        expect(response.body.pagination.limit).toBe(20);
      });

      it('should support status filtering', async () => {
        const response = await request(app)
          .get('/api/v2/contracts')
          .query({ status: 'active' });

        expect(response.status).toBe(200);
        expect(response.body.filters).toHaveProperty('status', 'active');
      });

      it('should not have deprecation headers', async () => {
        const response = await request(app).get('/api/v2/contracts');

        expect(response.headers).not.toHaveProperty('deprecation');
        expect(response.headers).not.toHaveProperty('sunset');
      });
    });

    describe('GET /api/v2/contracts/:id', () => {
      it('should return enhanced contract details', async () => {
        const response = await request(app).get('/api/v2/contracts/test-456');

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('version', 'v2');
        expect(response.body).toHaveProperty('contract');
        expect(response.body.contract).toHaveProperty('id', 'test-456');
        expect(response.body.contract).toHaveProperty('status');
        expect(response.body.contract).toHaveProperty('createdAt');
        expect(response.body.contract).toHaveProperty('updatedAt');
        expect(response.body.contract).toHaveProperty('metadata');
      });

      it('should include blockchain metadata', async () => {
        const response = await request(app).get('/api/v2/contracts/test-456');

        expect(response.body.contract.metadata).toHaveProperty('blockchain', 'stellar');
        expect(response.body.contract.metadata).toHaveProperty('network', 'testnet');
      });
    });
  });

  describe('Version Detection', () => {
    it('should detect version from URL path', async () => {
      const response = await request(app).get('/api/v2/contracts');

      expect(response.status).toBe(200);
      expect(response.body.version).toBe('v2');
    });

    it('should detect version from Accept header', async () => {
      const response = await request(app)
        .get('/api/v2/contracts')
        .set('Accept', 'application/vnd.talenttrust.v2+json');

      expect(response.status).toBe(200);
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for non-existent endpoints', async () => {
      const response = await request(app).get('/api/v1/nonexistent');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'Not Found');
      expect(response.body).toHaveProperty('message');
    });

    it('should handle invalid routes gracefully', async () => {
      const response = await request(app).get('/invalid/path');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('Security Headers', () => {
    it('should accept JSON content type', async () => {
      const response = await request(app)
        .post('/api/v1/contracts')
        .send({ test: 'data' })
        .set('Content-Type', 'application/json');

      // Even though endpoint doesn't exist, it should parse JSON
      expect(response.status).toBe(404);
    });
  });
});
