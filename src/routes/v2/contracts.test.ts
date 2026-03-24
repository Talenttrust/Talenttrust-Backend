/**
 * Contracts v2 Route Tests
 * Unit tests for v2 contract endpoints
 */

import request from 'supertest';
import express from 'express';
import contractsV2 from './contracts';

describe('Contracts v2 Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v2/contracts', contractsV2);
  });

  describe('GET /api/v2/contracts', () => {
    it('should return enhanced contracts list with pagination', async () => {
      const response = await request(app).get('/api/v2/contracts');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('version', 'v2');
      expect(response.body).toHaveProperty('contracts');
      expect(response.body).toHaveProperty('pagination');
      expect(Array.isArray(response.body.contracts)).toBe(true);
    });

    it('should support limit parameter', async () => {
      const response = await request(app)
        .get('/api/v2/contracts')
        .query({ limit: 25 });

      expect(response.status).toBe(200);
      expect(response.body.pagination.limit).toBe(25);
    });

    it('should support status filter', async () => {
      const response = await request(app)
        .get('/api/v2/contracts')
        .query({ status: 'completed' });

      expect(response.status).toBe(200);
      expect(response.body.filters).toHaveProperty('status', 'completed');
    });

    it('should use default limit when not specified', async () => {
      const response = await request(app).get('/api/v2/contracts');

      expect(response.status).toBe(200);
      expect(response.body.pagination.limit).toBe(10);
    });
  });

  describe('GET /api/v2/contracts/:id', () => {
    it('should return enhanced contract details', async () => {
      const response = await request(app).get('/api/v2/contracts/test-789');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('version', 'v2');
      expect(response.body).toHaveProperty('contract');
      expect(response.body.contract).toHaveProperty('id', 'test-789');
      expect(response.body.contract).toHaveProperty('status');
      expect(response.body.contract).toHaveProperty('createdAt');
      expect(response.body.contract).toHaveProperty('updatedAt');
      expect(response.body.contract).toHaveProperty('metadata');
    });

    it('should include blockchain metadata', async () => {
      const response = await request(app).get('/api/v2/contracts/test-789');

      expect(response.body.contract.metadata).toHaveProperty('blockchain', 'stellar');
      expect(response.body.contract.metadata).toHaveProperty('network', 'testnet');
    });

    it('should handle different contract IDs', async () => {
      const response = await request(app).get('/api/v2/contracts/xyz-999');

      expect(response.status).toBe(200);
      expect(response.body.contract.id).toBe('xyz-999');
    });
  });
});
