import request from 'supertest';
import app from '../index';
import { reputationStore } from '../models/reputation.store';

describe('Reputation API Integration Tests', () => {
  const freelancerId = 'api-user-123';

  beforeEach(() => {
    reputationStore.clear();
  });

  describe('GET /api/v1/reputation/:id', () => {
    it('should return a default profile for a new user', async () => {
      const response = await request(app).get(`/api/v1/reputation/${freelancerId}`);
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.freelancerId).toBe(freelancerId);
      expect(response.body.data.score).toBe(0);
      expect(response.body.data.totalRatings).toBe(0);
    });
  });

  describe('PUT /api/v1/reputation/:id', () => {
    it('should fail with 400 for invalid payload (missing rating)', async () => {
      const response = await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .send({ reviewerId: 'client-1' });
      
      expect(response.status).toBe(400);
      expect(response.body.message).toContain('reviewerId and rating are required');
    });

    it('should fail with 400 for invalid rating bounds', async () => {
      const response = await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .send({ reviewerId: 'client-1', rating: 10 });
      
      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Rating must be between 1 and 5');
    });

    it('should successfully update and return the new profile', async () => {
      const response = await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .send({ reviewerId: 'client-1', rating: 5, comment: 'Awesome', jobCompleted: true });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.score).toBe(5);
      expect(response.body.data.jobsCompleted).toBe(1);
    });

    it('should handle sequential updates correctly via the API', async () => {
      await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .send({ reviewerId: 'client-1', rating: 3, jobCompleted: true });

      const response = await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .send({ reviewerId: 'client-2', rating: 4, jobCompleted: true });

      expect(response.status).toBe(200);
      expect(response.body.data.score).toBe(3.5);
      expect(response.body.data.totalRatings).toBe(2);
      expect(response.body.data.jobsCompleted).toBe(2);
    });
  });
});
