import request from 'supertest';
import app from '../index';

describe('Contracts API Integration Tests', () => {
  describe('GET /health', () => {
    it('should return health status', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', service: 'talenttrust-backend' });
    });
  });

  describe('GET /api/v1/contracts', () => {
    it('should return a list of contracts (initially empty)', async () => {
      const res = await request(app).get('/api/v1/contracts');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'success', data: [] });
    });
  });

  describe('POST /api/v1/contracts', () => {
    it('should create a new contract with valid input', async () => {
      const payload = {
        title: 'Valid Contract Title',
        description: 'This is a valid long enough description.',
        budget: 1000
      };

      const res = await request(app)
        .post('/api/v1/contracts')
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.title).toBe(payload.title);
      expect(res.body.data.id).toBeDefined();
    });

    it('should return 400 validation error with invalid input (missing title)', async () => {
      const payload = {
        description: 'This is a valid long enough description.',
        budget: 1000
      };

      const res = await request(app)
        .post('/api/v1/contracts')
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toBe('Validation failed');
    });

    it('should return 400 validation error with invalid budget (negative)', async () => {
      const payload = {
        title: 'Valid Contract Title',
        description: 'This is a valid long enough description.',
        budget: -50
      };

      const res = await request(app)
        .post('/api/v1/contracts')
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
    });
  });
});
