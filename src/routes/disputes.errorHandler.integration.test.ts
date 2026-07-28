/**
 * @file disputes.errorHandler.integration.test.ts
 * @description Integration tests for disputes error handling middleware.
 *
 * These tests verify that the disputesErrorHandler middleware correctly
 * converts DisputeError instances from the service layer into AppError
 * instances that the global error handler can process consistently.
 *
 * Coverage goals:
 * - DisputeError from service layer is caught and converted
 * - HTTP status codes are mapped correctly
 * - Error responses follow the standard API contract
 * - requestId is included in error responses
 */

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { AppError } from '../errors/appError';
import { DisputeError, disputesService } from '../services/disputes.service';
import { disputesErrorHandler } from '../middleware/disputesErrorHandler';
import { errorHandler } from '../middleware/errorHandlers';

// Mock auth middleware
jest.mock('../middleware/authorization', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Mock rate limiter
jest.mock('../middleware/rateLimiter', () => ({
  createRateLimiter: () => (req: Request, res: Response, next: NextFunction) => next(),
}));

describe('Disputes error handling — integration with service layer', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    
    // Add disputes error handler before routes
    app.use(disputesErrorHandler);
    
    // Add a test route that uses the disputes service
    app.get('/api/v1/disputes/:id', (req: Request, res: Response, next: NextFunction) => {
      try {
        const dispute = disputesService.getDisputeById(req.params.id);
        res.status(200).json({ dispute });
      } catch (error) {
        next(error);
      }
    });

    // Add global error handler
    app.use(errorHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('dispute_not_found error', () => {
    it('returns 404 with standard error contract', async () => {
      const res = await request(app)
        .get('/api/v1/disputes/non-existent-id')
        .expect(404);

      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toHaveProperty('code');
      expect(res.body.error).toHaveProperty('message');
      expect(res.body.error).toHaveProperty('requestId');
      expect(res.body.error.code).toBe('dispute_not_found');
      expect(res.body.error.message).toBe('The requested dispute was not found');
    });

    it('includes requestId in error response', async () => {
      const res = await request(app)
        .get('/api/v1/disputes/non-existent-id')
        .expect(404);

      expect(res.body.error.requestId).toBeDefined();
      expect(typeof res.body.error.requestId).toBe('string');
    });

    it('does not expose internal error details', async () => {
      const res = await request(app)
        .get('/api/v1/disputes/non-existent-id')
        .expect(404);

      const bodyString = JSON.stringify(res.body);
      expect(bodyString).not.toContain('DisputeError');
      expect(bodyString).not.toContain('stack');
    });
  });

  describe('invalid_state_transition error', () => {
    it('returns 400 with standard error contract', async () => {
      // Add a route that triggers state transition validation
      app.patch('/api/v1/disputes/:id', (req: Request, res: Response, next: NextFunction) => {
        try {
          const dispute = disputesService.getDisputeById(req.params.id);
          disputesService.validateTransition(dispute.status, req.body.status);
          res.status(200).json({ dispute });
        } catch (error) {
          next(error);
        }
      });

      const res = await request(app)
        .patch('/api/v1/disputes/dispute-001')
        .send({ status: 'invalid_status' })
        .expect(400);

      expect(res.body).toHaveProperty('error');
      expect(res.body.error.code).toBe('invalid_state_transition');
      expect(res.body.error.message).toBe('The requested state transition is not allowed');
    });
  });

  describe('generic error handling', () => {
    it('handles non-DisputeError through global handler', async () => {
      app.get('/api/v1/disputes/error', (req: Request, res: Response, next: NextFunction) => {
        next(new Error('Generic error'));
      });

      const res = await request(app)
        .get('/api/v1/disputes/error')
        .expect(500);

      expect(res.body.error.code).toBe('internal_error');
      expect(res.body.error.message).toBe('An unexpected error occurred');
    });
  });

  describe('error contract consistency', () => {
    it('all dispute errors follow the same structure', async () => {
      const res = await request(app)
        .get('/api/v1/disputes/non-existent-id')
        .expect(404);

      // Verify standard error contract structure
      expect(res.body).toMatchObject({
        error: {
          code: expect.any(String),
          message: expect.any(String),
          requestId: expect.any(String),
        },
      });

      // Verify no extra fields that shouldn't be there
      expect(res.body.error).not.toHaveProperty('stack');
      expect(res.body.error).not.toHaveProperty('details'); // unless it's a validation error
    });
  });
});
