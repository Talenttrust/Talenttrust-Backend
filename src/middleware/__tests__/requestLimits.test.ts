/**
 * @title Request Limits Middleware Tests
 * @notice Comprehensive test suite for request body size and content-type validation
 */

import request from 'supertest';
import express from 'express';
import { createRequestLimitsMiddleware, requestLimitsMiddleware } from '../requestLimits';
import { AppError } from '../../errors/appError';

describe('Request Limits Middleware', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    
    // Set up middleware with test configuration
    app.use(express.json({ limit: '10mb' })); // Higher limit for testing
    app.use(createRequestLimitsMiddleware({
      maxBodySize: 1024, // 1KB for testing
      enforceJsonContentType: true,
      allowedContentTypes: ['application/json'],
      excludePaths: ['/health', '/test-exclude'],
    }));

    // Test routes
    app.post('/test', (req, res) => res.json({ success: true }));
    app.get('/health', (req, res) => res.json({ status: 'ok' }));
    app.post('/test-exclude', (req, res) => res.json({ success: true }));
  });

  describe('Request Body Size Limits', () => {
    it('should allow requests within size limit', async () => {
      const smallPayload = { data: 'small test payload' };
      
      const response = await request(app)
        .post('/test')
        .send(smallPayload)
        .set('Content-Type', 'application/json')
        .expect(200);

      expect(response.body).toEqual({ success: true });
    });

    it('should reject requests exceeding size limit via content-length header', async () => {
      const largePayload = { data: 'x'.repeat(2048) }; // 2KB payload
      
      const response = await request(app)
        .post('/test')
        .send(largePayload)
        .set('Content-Type', 'application/json')
        .set('Content-Length', '2048')
        .expect(413);

      expect(response.body.error.code).toBe('payload_too_large');
      expect(response.body.error.message).toContain('exceeds maximum allowed size');
    });

    it('should handle requests without content-length header', async () => {
      const response = await request(app)
        .post('/test')
        .send({ data: 'test' })
        .set('Content-Type', 'application/json')
        .expect(200);

      expect(response.body).toEqual({ success: true });
    });
  });

  describe('Content-Type Enforcement', () => {
    it('should allow requests with allowed content-type', async () => {
      const response = await request(app)
        .post('/test')
        .send({ data: 'test' })
        .set('Content-Type', 'application/json')
        .expect(200);

      expect(response.body).toEqual({ success: true });
    });

    it('should reject requests with missing content-type', async () => {
      const response = await request(app)
        .post('/test')
        .send({ data: 'test' })
        .expect(415);

      expect(response.body.error.code).toBe('unsupported_media_type');
      expect(response.body.error.message).toContain('Content-Type missing is not allowed');
    });

    it('should reject requests with unsupported content-type', async () => {
      const response = await request(app)
        .post('/test')
        .send('plain text data')
        .set('Content-Type', 'text/plain')
        .expect(415);

      expect(response.body.error.code).toBe('unsupported_media_type');
      expect(response.body.error.message).toContain('text/plain is not allowed');
    });

    it('should handle content-type with charset parameter', async () => {
      const response = await request(app)
        .post('/test')
        .send({ data: 'test' })
        .set('Content-Type', 'application/json; charset=utf-8')
        .expect(200);

      expect(response.body).toEqual({ success: true });
    });

    it('should allow GET requests without content-type validation', async () => {
      // Add a GET route for testing
      app.get('/test-get', (req, res) => res.json({ success: true }));

      const response = await request(app)
        .get('/test-get')
        .expect(200);

      expect(response.body).toEqual({ success: true });
    });

    it('should allow HEAD requests without content-type validation', async () => {
      // Add a HEAD route for testing
      app.head('/test-head', (req, res) => res.status(200).end());

      await request(app)
        .head('/test-head')
        .expect(200);
    });
  });

  describe('Path Exclusions', () => {
    it('should exclude specified paths from validation', async () => {
      // This should work even with large payload and wrong content-type
      const response = await request(app)
        .post('/test-exclude')
        .send({ data: 'x'.repeat(2048) }) // Large payload
        .set('Content-Type', 'text/plain') // Wrong content-type
        .expect(200);

      expect(response.body).toEqual({ success: true });
    });

    it('should still validate non-excluded paths', async () => {
      const response = await request(app)
        .post('/test')
        .send('plain text')
        .set('Content-Type', 'text/plain')
        .expect(415);

      expect(response.body.error.code).toBe('unsupported_media_type');
    });
  });

  describe('Configuration', () => {
    it('should use custom configuration when provided', async () => {
      const customApp = express();
      customApp.use(express.json());
      
      // Custom config with different limits and content types
      customApp.use(createRequestLimitsMiddleware({
        maxBodySize: 100, // 100 bytes
        enforceJsonContentType: false,
        allowedContentTypes: ['application/json', 'text/plain'],
        excludePaths: [],
      }));

      customApp.post('/custom-test', (req, res) => res.json({ success: true }));

      // Should allow text/plain with custom config
      const response = await request(customApp)
        .post('/custom-test')
        .send('plain text data')
        .set('Content-Type', 'text/plain')
        .expect(200);

      expect(response.body).toEqual({ success: true });
    });

    it('should handle environment variable configuration', async () => {
      // Mock environment variables
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        MAX_REQUEST_BODY_SIZE: '500',
        ENFORCE_JSON_CONTENT_TYPE: 'false',
        ALLOWED_CONTENT_TYPES: 'application/json,text/plain,application/xml',
        REQUEST_LIMITS_EXCLUDE_PATHS: '/custom-exclude',
      };

      const envApp = express();
      envApp.use(express.json());
      envApp.use(requestLimitsMiddleware); // Uses environment config
      envApp.post('/env-test', (req, res) => res.json({ success: true }));
      envApp.post('/custom-exclude', (req, res) => res.json({ success: true }));

      try {
        // Should allow text/plain due to env config
        const response = await request(envApp)
          .post('/env-test')
          .send('plain text')
          .set('Content-Type', 'text/plain')
          .expect(200);

        expect(response.body).toEqual({ success: true });
      } finally {
        // Restore original environment
        process.env = originalEnv;
      }
    });
  });

  describe('Error Handling', () => {
    it('should include requestId in error responses', async () => {
      // Add request ID middleware for testing
      app.use((req, res, next) => {
        res.locals.requestId = 'test-request-id';
        next();
      });

      const response = await request(app)
        .post('/test')
        .send('plain text')
        .set('Content-Type', 'text/plain')
        .expect(415);

      expect(response.body.error.requestId).toBe('test-request-id');
    });

    it('should use AppError for consistent error format', async () => {
      const response = await request(app)
        .post('/test')
        .send('plain text')
        .set('Content-Type', 'text/plain')
        .expect(415);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code');
      expect(response.body.error).toHaveProperty('message');
      expect(response.body.error).toHaveProperty('requestId');
    });
  });
});
