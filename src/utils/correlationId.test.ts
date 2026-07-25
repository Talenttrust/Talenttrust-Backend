/**
 * @module utils/correlationId.test
 * @description Unit tests for correlation ID utility functions.
 *
 * Tests:
 * - Extracting correlation IDs from response locals
 * - Extracting request IDs from response locals
 * - Building webhook headers with correlation IDs
 * - Error handling for missing context
 */

import { Response } from 'express';
import {
  getCorrelationId,
  getRequestId,
  getRequestLogger,
  getRequestContext,
  buildWebhookHeaders,
  isValidCorrelationId,
  sanitizeCorrelationId,
} from './correlationId';

describe('correlationId utilities', () => {
  describe('sanitizeCorrelationId', () => {
    it('should accept alphanumeric, hyphen, and underscore IDs up to 128 chars', () => {
      const id = `Trace_ID-${'a'.repeat(119)}`;

      expect(isValidCorrelationId(id)).toBe(true);
      expect(sanitizeCorrelationId(id)).toBe(id);
    });

    it('should reject CRLF header injection payloads', () => {
      const malicious = 'trace\r\nX-Injected-Header: yes';

      expect(isValidCorrelationId(malicious)).toBe(false);
      expect(sanitizeCorrelationId(malicious)).toBeUndefined();
    });

    it('should reject empty, non-string, and over-length IDs', () => {
      expect(sanitizeCorrelationId('')).toBeUndefined();
      expect(sanitizeCorrelationId(123)).toBeUndefined();
      expect(sanitizeCorrelationId(null)).toBeUndefined();
      expect(sanitizeCorrelationId('a'.repeat(129))).toBeUndefined();
    });
  });

  describe('getCorrelationId', () => {
    /**
     * Should return the correlation ID from response locals when present.
     */
    it('should return correlation ID when set in res.locals', () => {
      const res = {
        locals: { correlationId: 'test-correlation-123' },
      } as any as Response;

      const result = getCorrelationId(res);

      expect(result).toBe('test-correlation-123');
    });

    /**
     * Should return undefined when correlation ID is not set.
     */
    it('should return undefined when correlation ID is not set', () => {
      const res = {
        locals: {},
      } as any as Response;

      const result = getCorrelationId(res);

      expect(result).toBeUndefined();
    });

    /**
     * Should return undefined when locals is empty.
     */
    it('should return undefined when locals is empty', () => {
      const res = {
        locals: {},
      } as any as Response;

      const result = getCorrelationId(res);

      expect(result).toBeUndefined();
    });

    it('should return undefined when locals contains an unsafe correlation ID', () => {
      const res = {
        locals: { correlationId: 'bad\nheader' },
      } as any as Response;

      expect(getCorrelationId(res)).toBeUndefined();
    });
  });

  describe('getRequestId', () => {
    /**
     * Should return the request ID from response locals.
     */
    it('should return request ID when set in res.locals', () => {
      const res = {
        locals: { requestId: 'req-uuid-123' },
      } as any as Response;

      const result = getRequestId(res);

      expect(result).toBe('req-uuid-123');
    });

    /**
     * Should throw an error when request ID is not set.
     */
    it('should throw error when request ID is not set', () => {
      const res = {
        locals: {},
      } as any as Response;

      expect(() => getRequestId(res)).toThrow(
        'Request ID not found in response locals'
      );
    });

    /**
     * Should throw a specific error message when request ID is missing.
     */
    it('should provide helpful error message when request ID is missing', () => {
      const res = {
        locals: {},
      } as any as Response;

      expect(() => getRequestId(res)).toThrow(
        /Ensure requestIdMiddleware is registered/
      );
    });
  });

  describe('getRequestLogger', () => {
    /**
     * Should return the logger from response locals when present.
     */
    it('should return logger when set in res.locals', () => {
      const mockLogger = { info: jest.fn() };
      const res = {
        locals: { log: mockLogger },
      } as any as Response;

      const result = getRequestLogger(res);

      expect(result).toBe(mockLogger);
    });

    /**
     * Should throw an error when logger is not set.
     */
    it('should throw error when logger is not set', () => {
      const res = {
        locals: {},
      } as any as Response;

      expect(() => getRequestLogger(res)).toThrow(
        'Request logger not found in response locals'
      );
    });

    /**
     * Should throw a specific error message when logger is missing.
     */
    it('should provide helpful error message when logger is missing', () => {
      const res = {
        locals: {},
      } as any as Response;

      expect(() => getRequestLogger(res)).toThrow(
        /Ensure requestIdMiddleware is registered/
      );
    });
  });

  describe('getRequestContext', () => {
    /**
     * Should return both request ID and correlation ID when both are set.
     */
    it('should return both requestId and correlationId when set', () => {
      const res = {
        locals: {
          requestId: 'req-123',
          correlationId: 'corr-456',
        },
      } as any as Response;

      const result = getRequestContext(res);

      expect(result).toEqual({
        requestId: 'req-123',
        correlationId: 'corr-456',
      });
    });

    /**
     * Should return request ID with undefined correlation ID when only request ID is set.
     */
    it('should return correlationId as undefined when not set', () => {
      const res = {
        locals: {
          requestId: 'req-789',
        },
      } as any as Response;

      const result = getRequestContext(res);

      expect(result).toEqual({
        requestId: 'req-789',
        correlationId: undefined,
      });
    });

    /**
     * Should throw an error when request ID is missing.
     */
    it('should throw error when requestId is missing', () => {
      const res = {
        locals: {
          correlationId: 'corr-456',
        },
      } as any as Response;

      expect(() => getRequestContext(res)).toThrow(
        'Request ID not found in response locals'
      );
    });
  });

  describe('buildWebhookHeaders', () => {
    /**
     * Should include Content-Type header.
     */
    it('should include Content-Type header', () => {
      const headers = buildWebhookHeaders();

      expect(headers['Content-Type']).toBe('application/json');
    });

    /**
     * Should include correlation ID in headers when provided.
     */
    it('should include X-Correlation-Id when provided', () => {
      const correlationId = 'trace-webhook-123';
      const headers = buildWebhookHeaders(correlationId);

      expect(headers['X-Correlation-Id']).toBe(correlationId);
      expect(headers['Content-Type']).toBe('application/json');
    });

    /**
     * Should not include correlation ID header when undefined.
     */
    it('should not include X-Correlation-Id when undefined', () => {
      const headers = buildWebhookHeaders(undefined);

      expect(headers['X-Correlation-Id']).toBeUndefined();
      expect(headers['Content-Type']).toBe('application/json');
    });

    /**
     * Should not include correlation ID header when empty string.
     */
    it('should not include X-Correlation-Id when empty string', () => {
      const headers = buildWebhookHeaders('');

      expect(headers['X-Correlation-Id']).toBeUndefined();
      expect(headers['Content-Type']).toBe('application/json');
    });

    /**
     * Should return correct headers for multiple calls with different IDs.
     */
    it('should return different headers for different correlation IDs', () => {
      const headers1 = buildWebhookHeaders('trace-1');
      const headers2 = buildWebhookHeaders('trace-2');

      expect(headers1['X-Correlation-Id']).toBe('trace-1');
      expect(headers2['X-Correlation-Id']).toBe('trace-2');
    });

    /**
     * Should support long correlation IDs (up to 128 chars).
     */
    it('should support long correlation IDs', () => {
      const longId = 'a'.repeat(128);
      const headers = buildWebhookHeaders(longId);

      expect(headers['X-Correlation-Id']).toBe(longId);
    });

    it('should omit unsafe correlation IDs from webhook headers', () => {
      const headers = buildWebhookHeaders('trace\r\nX-Evil: yes');

      expect(headers['X-Correlation-Id']).toBeUndefined();
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should omit over-length correlation IDs from webhook headers', () => {
      const headers = buildWebhookHeaders('a'.repeat(129));

      expect(headers['X-Correlation-Id']).toBeUndefined();
      expect(headers['Content-Type']).toBe('application/json');
    });
  });
});
