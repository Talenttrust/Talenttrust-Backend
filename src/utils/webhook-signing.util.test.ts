import {
  generateSignature,
  createWebhookSignature,
  verifySignature
} from './webhook-signing.util';

describe('Webhook Signing Utility', () => {
  const secret = 'test-webhook-secret';
  const payload = { event: 'user.created', data: { id: '123', email: 'test@example.com' } };

  describe('generateSignature', () => {
    it('should generate a consistent HMAC signature for the same input', () => {
      const timestamp = 1640995200000; // Fixed timestamp for testing
      const signature1 = generateSignature(payload, secret, timestamp);
      const signature2 = generateSignature(payload, secret, timestamp);
      
      expect(signature1).toBe(signature2);
      expect(signature1).toMatch(/^[a-f0-9]{64}$/); // 64 character hex string
    });

    it('should generate different signatures for different timestamps', () => {
      const timestamp1 = 1640995200000;
      const timestamp2 = 1640995201000;
      const signature1 = generateSignature(payload, secret, timestamp1);
      const signature2 = generateSignature(payload, secret, timestamp2);
      
      expect(signature1).not.toBe(signature2);
    });

    it('should generate different signatures for different secrets', () => {
      const timestamp = 1640995200000;
      const secret1 = 'secret1';
      const secret2 = 'secret2';
      const signature1 = generateSignature(payload, secret1, timestamp);
      const signature2 = generateSignature(payload, secret2, timestamp);
      
      expect(signature1).not.toBe(signature2);
    });

    it('should generate different signatures for different payloads', () => {
      const timestamp = 1640995200000;
      const payload1 = { event: 'user.created' };
      const payload2 = { event: 'user.updated' };
      const signature1 = generateSignature(payload1, secret, timestamp);
      const signature2 = generateSignature(payload2, secret, timestamp);
      
      expect(signature1).not.toBe(signature2);
    });
  });

  describe('createWebhookSignature', () => {
    it('should create a signature with current timestamp', () => {
      const beforeTime = Date.now();
      const result = createWebhookSignature(payload, secret);
      const afterTime = Date.now();
      
      expect(result).toHaveProperty('signature');
      expect(result).toHaveProperty('timestamp');
      expect(result.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(result.timestamp).toBeLessThanOrEqual(afterTime);
      expect(result.signature).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('verifySignature', () => {
    it('should verify a valid signature', () => {
      const timestamp = Date.now();
      const signature = generateSignature(payload, secret, timestamp);
      
      const isValid = verifySignature(payload, signature, timestamp, secret);
      expect(isValid).toBe(true);
    });

    it('should reject an invalid signature', () => {
      const timestamp = Date.now();
      const invalidSignature = 'invalid-signature';
      
      const isValid = verifySignature(payload, invalidSignature, timestamp, secret);
      expect(isValid).toBe(false);
    });

    it('should reject a signature with wrong secret', () => {
      const timestamp = Date.now();
      const signature = generateSignature(payload, secret, timestamp);
      const wrongSecret = 'wrong-secret';
      
      const isValid = verifySignature(payload, signature, timestamp, wrongSecret);
      expect(isValid).toBe(false);
    });

    it('should reject a signature with modified payload', () => {
      const timestamp = Date.now();
      const signature = generateSignature(payload, secret, timestamp);
      const modifiedPayload = { ...payload, data: { id: '456' } };
      
      const isValid = verifySignature(modifiedPayload, signature, timestamp, secret);
      expect(isValid).toBe(false);
    });

    it('should reject an old timestamp (more than 5 minutes)', () => {
      const oldTimestamp = Date.now() - (6 * 60 * 1000); // 6 minutes ago
      const signature = generateSignature(payload, secret, oldTimestamp);
      
      const isValid = verifySignature(payload, signature, oldTimestamp, secret);
      expect(isValid).toBe(false);
    });

    it('should accept a recent timestamp (less than 5 minutes)', () => {
      const recentTimestamp = Date.now() - (4 * 60 * 1000); // 4 minutes ago
      const signature = generateSignature(payload, secret, recentTimestamp);
      
      const isValid = verifySignature(payload, signature, recentTimestamp, secret);
      expect(isValid).toBe(true);
    });

    it('should handle edge case of exactly 5 minutes', () => {
      const exactly5Minutes = Date.now() - (5 * 60 * 1000); // Exactly 5 minutes ago
      const signature = generateSignature(payload, secret, exactly5Minutes);
      
      const isValid = verifySignature(payload, signature, exactly5Minutes, secret);
      expect(isValid).toBe(false); // Should be rejected as it's exactly 5 minutes
    });
  });

  describe('Integration Tests', () => {
    it('should work end-to-end: create signature and verify it', () => {
      const { signature, timestamp } = createWebhookSignature(payload, secret);
      
      const isValid = verifySignature(payload, signature, timestamp, secret);
      expect(isValid).toBe(true);
    });

    it('should handle complex nested payloads', () => {
      const complexPayload = {
        event: 'order.completed',
        data: {
          orderId: '12345',
          items: [
            { id: 1, name: 'Product A', price: 29.99 },
            { id: 2, name: 'Product B', price: 49.99 }
          ],
          customer: {
            id: 'cust-123',
            email: 'customer@example.com',
            address: {
              street: '123 Main St',
              city: 'Anytown',
              country: 'US'
            }
          },
          metadata: {
            source: 'web',
            utm: { campaign: 'spring-sale' }
          }
        }
      };

      const { signature, timestamp } = createWebhookSignature(complexPayload, secret);
      
      const isValid = verifySignature(complexPayload, signature, timestamp, secret);
      expect(isValid).toBe(true);
    });

    it('should handle empty payload', () => {
      const emptyPayload = {};
      const { signature, timestamp } = createWebhookSignature(emptyPayload, secret);
      
      const isValid = verifySignature(emptyPayload, signature, timestamp, secret);
      expect(isValid).toBe(true);
    });

    it('should handle null and undefined values in payload', () => {
      const payloadWithNulls = {
        event: 'test.event',
        data: {
          id: '123',
          name: null,
          description: undefined,
          active: true
        }
      };

      const { signature, timestamp } = createWebhookSignature(payloadWithNulls, secret);
      
      const isValid = verifySignature(payloadWithNulls, signature, timestamp, secret);
      expect(isValid).toBe(true);
    });
  });
});
