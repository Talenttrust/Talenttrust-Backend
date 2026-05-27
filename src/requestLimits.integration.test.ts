/**
 * @title Request Limits Integration Tests
 * @notice Integration tests for request limits middleware with the full application
 */

import request from 'supertest';
import { createApp } from './app';

describe('Request Limits Integration Tests', () => {
  let app: any;

  beforeAll(() => {
    app = createApp({ includeTerminalHandlers: true });
  });

  describe('Body Size Limits', () => {
    it('should accept normal-sized requests', async () => {
      const response = await request(app)
        .post('/api/config')
        .send({ status: 'ok' })
        .set('Content-Type', 'application/json')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'ok');
    });

    it('should reject oversized requests', async () => {
      // Create a payload larger than the default 1MB limit
      const largePayload = {
        data: 'x'.repeat(2 * 1024 * 1024), // 2MB of data
      };

      try {
        const response = await request(app)
          .post('/api/config')
          .send(largePayload)
          .set('Content-Type', 'application/json')
          .set('Content-Length', (2 * 1024 * 1024 + 50).toString()); // Approximate size
        
        expect(response.status).toBe(413);
        expect(response.body.error.code).toBe('payload_too_large');
        expect(response.body.error.message).toContain('Payload Too Large');
        expect(response.body.error).toHaveProperty('requestId');
      } catch (error: any) {
        const isAbortError = error.code === 'ECONNRESET' || error.code === 'EPIPE' || error.message.includes('hang up') || error.message.includes('aborted');
        expect(isAbortError).toBe(true);
      }
    });
  });

  describe('Content-Type Enforcement', () => {
    it('should allow JSON content-type', async () => {
      const response = await request(app)
        .post('/api/config')
        .send({ status: 'test' })
        .set('Content-Type', 'application/json')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'ok');
    });

    it('should allow JSON with charset', async () => {
      const response = await request(app)
        .post('/api/config')
        .send({ status: 'test' })
        .set('Content-Type', 'application/json; charset=utf-8')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'ok');
    });

    it('should reject non-JSON content-type', async () => {
      const response = await request(app)
        .post('/api/config')
        .send('plain text data')
        .set('Content-Type', 'text/plain')
        .expect(415);

      expect(response.body.error.code).toBe('unsupported_media_type');
      expect(response.body.error.message).toContain('text/plain is not allowed');
      expect(response.body.error).toHaveProperty('requestId');
    });

    it('should reject missing content-type', async () => {
      const response = await request(app)
        .post('/api/config')
        .send('{"status":"test"}')
        .unset('Content-Type')
        .expect(415);

      expect(response.body.error.code).toBe('unsupported_media_type');
      expect(response.body.error.message).toContain('Content-Type missing is not allowed');
    });

    it('should allow GET requests without content-type validation', async () => {
      const response = await request(app)
        .get('/api/config')
        .expect(200);

      expect(response.body).toHaveProperty('allowedAssets');
    });
  });

  describe('Path Exclusions', () => {
    it('should exclude health endpoint from validation', async () => {
      // This should work even with invalid content-type since /health is excluded
      const response = await request(app)
        .post('/health')
        .send('any data')
        .set('Content-Type', 'text/plain')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'ok');
    });

    it('should validate API endpoints', async () => {
      // API endpoints should be subject to validation
      const response = await request(app)
        .post('/api/v1/contracts')
        .send('invalid data')
        .set('Content-Type', 'text/plain')
        .expect(415);

      expect(response.body.error.code).toBe('unsupported_media_type');
    });
  });

  describe('Error Response Format', () => {
    it('should maintain consistent error envelope', async () => {
      const response = await request(app)
        .post('/api/config')
        .send('invalid data')
        .set('Content-Type', 'text/plain')
        .expect(415);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code');
      expect(response.body.error).toHaveProperty('message');
      expect(response.body.error).toHaveProperty('requestId');
      
      // Verify requestId is a string
      expect(typeof response.body.error.requestId).toBe('string');
    });

    it('should handle multiple validation errors', async () => {
      // Test both size limit and content-type violations
      const largePayload = 'x'.repeat(2 * 1024 * 1024); // 2MB

      try {
        const response = await request(app)
          .post('/api/v1/contracts')
          .send(largePayload)
          .set('Content-Type', 'text/plain')
          .set('Content-Length', largePayload.length.toString());

        // Content-type validation should happen first
        expect(response.status).toBe(415);
        expect(response.body.error.code).toBe('unsupported_media_type');
      } catch (error: any) {
        const isAbortError = error.code === 'ECONNRESET' || error.code === 'EPIPE' || error.message.includes('hang up') || error.message.includes('aborted');
        expect(isAbortError).toBe(true);
      }
    });
  });

  describe('Environment Configuration', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should respect custom size limit from environment', async () => {
      process.env = {
        ...originalEnv,
        MAX_REQUEST_BODY_SIZE: '100', // 100 bytes
      };

      // Create a new app instance with updated environment
      const customApp = createApp({ includeTerminalHandlers: true });

      const response = await request(customApp)
        .post('/api/config')
        .send({ data: 'x'.repeat(200) }) // 200 bytes
        .set('Content-Type', 'application/json')
        .set('Content-Length', '200')
        .expect(413);

      expect(response.body.error.code).toBe('payload_too_large');
    });

    it('should respect content-type settings from environment', async () => {
      process.env = {
        ...originalEnv,
        ENFORCE_JSON_CONTENT_TYPE: 'false',
        ALLOWED_CONTENT_TYPES: 'application/json,text/plain',
      };

      const customApp = createApp({ includeTerminalHandlers: true });

      const response = await request(customApp)
        .post('/api/config')
        .send('plain text data')
        .set('Content-Type', 'text/plain')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'ok');
    });
  });

  describe('Streaming Limits & Boundary Cases', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should reject chunked uploads exceeding size limit early during streaming', async () => {
      process.env = {
        ...originalEnv,
        MAX_REQUEST_BODY_SIZE: '1000', // 1000 bytes
      };

      const customApp = createApp({ includeTerminalHandlers: true });

      const reqStream = request(customApp)
        .post('/api/config')
        .set('Content-Type', 'application/json')
        .set('Transfer-Encoding', 'chunked');

      try {
        const response = await new Promise<any>((resolve, reject) => {
          reqStream.write(JSON.stringify({ data: 'x'.repeat(200) }));
          setTimeout(() => {
            reqStream.write(JSON.stringify({ data: 'x'.repeat(2000) }));
            reqStream.end((err: any, res: any) => {
              if (err) reject(err);
              else resolve(res);
            });
          }, 50);
        });

        expect(response.status).toBe(413);
        expect(response.body.error.code).toBe('payload_too_large');
      } catch (error: any) {
        const isAbortError = error.code === 'ECONNRESET' || error.code === 'EPIPE' || error.message.includes('hang up') || error.message.includes('aborted');
        expect(isAbortError).toBe(true);
      }
    });

    it('should accept a request exactly at the limit boundary', async () => {
      process.env = {
        ...originalEnv,
        MAX_REQUEST_BODY_SIZE: '100', // 100 bytes
      };

      const customApp = createApp({ includeTerminalHandlers: true });

      const payload = '{"data":"' + 'x'.repeat(89) + '"}';
      expect(payload.length).toBe(100);

      const response = await request(customApp)
        .post('/api/config')
        .set('Content-Type', 'application/json')
        .set('Content-Length', '100')
        .send(payload)
        .expect(200);

      expect(response.body).toHaveProperty('status', 'ok');
    });

    it('should reject a request that is 1 byte over the limit boundary', async () => {
      process.env = {
        ...originalEnv,
        MAX_REQUEST_BODY_SIZE: '100', // 100 bytes
      };

      const customApp = createApp({ includeTerminalHandlers: true });

      const payload = '{"data":"' + 'x'.repeat(90) + '"}';
      expect(payload.length).toBe(101);

      try {
        const response = await request(customApp)
          .post('/api/config')
          .set('Content-Type', 'application/json')
          .set('Content-Length', '101')
          .send(payload);

        expect(response.status).toBe(413);
        expect(response.body.error.code).toBe('payload_too_large');
      } catch (error: any) {
        const isAbortError = error.code === 'ECONNRESET' || error.code === 'EPIPE' || error.message.includes('hang up') || error.message.includes('aborted');
        expect(isAbortError).toBe(true);
      }
    });
  });
});
