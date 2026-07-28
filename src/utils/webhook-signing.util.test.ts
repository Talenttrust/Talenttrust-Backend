import {
  generateSignature,
  createWebhookSignature,
  normalizeSignatureHeader,
  constantTimeCompareHex,
  verifyWebhookSignature,
  verifySignature,
  WEBHOOK_VERIFICATION_CODES,
  WEBHOOK_SIGNATURE_MAX_AGE_MS,
  WEBHOOK_SIGNATURE_HEX_LENGTH,
} from './webhook-signing.util';

/**
 * Fixed test fixtures for deterministic webhook signing tests.
 * @internal Used only in unit tests to ensure reproducibility.
 */
const FIXTURES = {
  SECRET: 'test-webhook-secret-123456',
  PAYLOAD: { event: 'test.event', data: { id: 'test-123', value: 42 } },
  EMPTY_PAYLOAD: {},
  TIMESTAMP: 1719345600000, // Fixed timestamp for reproducibility
};

describe('Webhook Signing Utility', () => {
  describe('generateSignature', () => {
    it('should generate consistent HMAC-SHA256 signature for fixed inputs', () => {
      const signature1 = generateSignature(FIXTURES.PAYLOAD, FIXTURES.SECRET, FIXTURES.TIMESTAMP);
      const signature2 = generateSignature(FIXTURES.PAYLOAD, FIXTURES.SECRET, FIXTURES.TIMESTAMP);
      
      expect(signature1).toBe(signature2);
      expect(signature1).toHaveLength(WEBHOOK_SIGNATURE_HEX_LENGTH);
    });

    it('should generate different signatures for different payloads', () => {
      const sig1 = generateSignature(FIXTURES.PAYLOAD, FIXTURES.SECRET, FIXTURES.TIMESTAMP);
      const sig2 = generateSignature({ ...FIXTURES.PAYLOAD, data: { id: 'different' } }, FIXTURES.SECRET, FIXTURES.TIMESTAMP);
      
      expect(sig1).not.toBe(sig2);
    });

    it('should generate different signatures for different secrets', () => {
      const sig1 = generateSignature(FIXTURES.PAYLOAD, FIXTURES.SECRET, FIXTURES.TIMESTAMP);
      const sig2 = generateSignature(FIXTURES.PAYLOAD, 'different-secret', FIXTURES.TIMESTAMP);
      
      expect(sig1).not.toBe(sig2);
    });

    it('should generate different signatures for different timestamps', () => {
      const sig1 = generateSignature(FIXTURES.PAYLOAD, FIXTURES.SECRET, FIXTURES.TIMESTAMP);
      const sig2 = generateSignature(FIXTURES.PAYLOAD, FIXTURES.SECRET, FIXTURES.TIMESTAMP + 1);
      
      expect(sig1).not.toBe(sig2);
    });

    it('should handle empty payloads', () => {
      const signature = generateSignature(FIXTURES.EMPTY_PAYLOAD, FIXTURES.SECRET, FIXTURES.TIMESTAMP);
      expect(signature).toHaveLength(WEBHOOK_SIGNATURE_HEX_LENGTH);
    });
  });

  describe('createWebhookSignature', () => {
    it('should return valid signature and timestamp', () => {
      const result = createWebhookSignature(FIXTURES.PAYLOAD, FIXTURES.SECRET);
      
      expect(result).toHaveProperty('signature');
      expect(result).toHaveProperty('timestamp');
      expect(result.signature).toHaveLength(WEBHOOK_SIGNATURE_HEX_LENGTH);
      expect(typeof result.timestamp).toBe('number');
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('should produce a verifiable signature', () => {
      const { signature, timestamp } = createWebhookSignature(FIXTURES.PAYLOAD, FIXTURES.SECRET);
      const isValid = verifySignature(FIXTURES.PAYLOAD, signature, timestamp, FIXTURES.SECRET, { now: timestamp });
      
      expect(isValid).toBe(true);
    });
  });

  describe('normalizeSignatureHeader', () => {
    it('should return null for non-string inputs', () => {
      expect(normalizeSignatureHeader(123)).toBeNull();
      expect(normalizeSignatureHeader(null)).toBeNull();
      expect(normalizeSignatureHeader(undefined)).toBeNull();
      expect(normalizeSignatureHeader({})).toBeNull();
    });

    it('should return null for empty/whitespace strings', () => {
      expect(normalizeSignatureHeader('')).toBeNull();
      expect(normalizeSignatureHeader('   ')).toBeNull();
    });

    it('should strip sha256= prefix', () => {
      const hex = 'a'.repeat(64);
      expect(normalizeSignatureHeader(`sha256=${hex}`)).toBe(hex);
      expect(normalizeSignatureHeader(`SHA256=${hex}`)).toBe(hex.toLowerCase());
    });

    it('should accept raw hex signatures', () => {
      const hex = 'a'.repeat(64);
      expect(normalizeSignatureHeader(hex)).toBe(hex);
    });

    it('should convert to lowercase', () => {
      const hex = 'ABCDEF1234567890';
      expect(normalizeSignatureHeader(hex)).toBe(hex.toLowerCase());
    });

    it('should reject non-hex characters', () => {
      expect(normalizeSignatureHeader('g'.repeat(64))).toBeNull();
      expect(normalizeSignatureHeader('a!b'.repeat(20))).toBeNull();
    });

    it('should trim whitespace', () => {
      const hex = 'a'.repeat(64);
      expect(normalizeSignatureHeader(`  ${hex}  `)).toBe(hex);
    });
  });

  describe('constantTimeCompareHex', () => {
    it('should return true for identical hex strings', () => {
      const hex = 'a'.repeat(64);
      expect(constantTimeCompareHex(hex, hex)).toBe(true);
    });

    it('should return false for different hex strings', () => {
      const hex1 = 'a'.repeat(64);
      const hex2 = 'b'.repeat(64);
      expect(constantTimeCompareHex(hex1, hex2)).toBe(false);
    });

    it('should return false for different length strings', () => {
      const hex1 = 'a'.repeat(64);
      const hex2 = 'a'.repeat(63);
      expect(constantTimeCompareHex(hex1, hex2)).toBe(false);
    });

    it('should return false for single-bit differences', () => {
      const hex1 = '0'.repeat(63) + '0';
      const hex2 = '0'.repeat(63) + '1';
      expect(constantTimeCompareHex(hex1, hex2)).toBe(false);
    });

    it('should never throw on invalid inputs', () => {
      expect(() => constantTimeCompareHex('', '')).not.toThrow();
      expect(() => constantTimeCompareHex('not-hex', 'not-hex')).not.toThrow();
    });
  });

  describe('verifyWebhookSignature', () => {
    let validSignature: string;

    beforeEach(() => {
      validSignature = generateSignature(FIXTURES.PAYLOAD, FIXTURES.SECRET, FIXTURES.TIMESTAMP);
    });

    describe('valid signatures', () => {
      it('should return valid for correct signature, secret, and timestamp', () => {
        const result = verifyWebhookSignature(
          FIXTURES.PAYLOAD,
          validSignature,
          FIXTURES.TIMESTAMP,
          FIXTURES.SECRET,
          { now: FIXTURES.TIMESTAMP }
        );
        
        expect(result.valid).toBe(true);
        expect(result.code).toBe(WEBHOOK_VERIFICATION_CODES.VALID);
      });

      it('should accept signature with sha256= prefix', () => {
        const result = verifyWebhookSignature(
          FIXTURES.PAYLOAD,
          `sha256=${validSignature}`,
          FIXTURES.TIMESTAMP,
          FIXTURES.SECRET,
          { now: FIXTURES.TIMESTAMP }
        );
        
        expect(result.valid).toBe(true);
      });

      it('should accept empty payloads', () => {
        const emptySig = generateSignature(FIXTURES.EMPTY_PAYLOAD, FIXTURES.SECRET, FIXTURES.TIMESTAMP);
        const result = verifyWebhookSignature(
          FIXTURES.EMPTY_PAYLOAD,
          emptySig,
          FIXTURES.TIMESTAMP,
          FIXTURES.SECRET,
          { now: FIXTURES.TIMESTAMP }
        );
        
        expect(result.valid).toBe(true);
      });
    });

    describe('invalid signatures', () => {
      it('should reject tampered payloads', () => {
        const result = verifyWebhookSignature(
          { ...FIXTURES.PAYLOAD, data: { id: 'tampered' } },
          validSignature,
          FIXTURES.TIMESTAMP,
          FIXTURES.SECRET,
          { now: FIXTURES.TIMESTAMP }
        );
        
        expect(result.valid).toBe(false);
        expect(result.code).toBe(WEBHOOK_VERIFICATION_CODES.SIGNATURE_MISMATCH);
      });

      it('should reject tampered signatures (single-bit change)', () => {
        const tamperedSignature = validSignature.slice(0, -1) + (validSignature.slice(-1) === 'a' ? 'b' : 'a');
        const result = verifyWebhookSignature(
          FIXTURES.PAYLOAD,
          tamperedSignature,
          FIXTURES.TIMESTAMP,
          FIXTURES.SECRET,
          { now: FIXTURES.TIMESTAMP }
        );
        
        expect(result.valid).toBe(false);
        expect(result.code).toBe(WEBHOOK_VERIFICATION_CODES.SIGNATURE_MISMATCH);
      });

      it('should reject wrong secrets', () => {
        const result = verifyWebhookSignature(
          FIXTURES.PAYLOAD,
          validSignature,
          FIXTURES.TIMESTAMP,
          'wrong-secret',
          { now: FIXTURES.TIMESTAMP }
        );
        
        expect(result.valid).toBe(false);
        expect(result.code).toBe(WEBHOOK_VERIFICATION_CODES.SIGNATURE_MISMATCH);
      });
    });

    describe('timestamp validation', () => {
      it('should reject expired timestamps', () => {
        const result = verifyWebhookSignature(
          FIXTURES.PAYLOAD,
          validSignature,
          FIXTURES.TIMESTAMP,
          FIXTURES.SECRET,
          { now: FIXTURES.TIMESTAMP + WEBHOOK_SIGNATURE_MAX_AGE_MS + 1 }
        );
        
        expect(result.valid).toBe(false);
        expect(result.code).toBe(WEBHOOK_VERIFICATION_CODES.TIMESTAMP_EXPIRED);
      });

      it('should reject invalid timestamps', () => {
        const result1 = verifyWebhookSignature(FIXTURES.PAYLOAD, validSignature, -1, FIXTURES.SECRET, { now: FIXTURES.TIMESTAMP });
        const result2 = verifyWebhookSignature(FIXTURES.PAYLOAD, validSignature, 'not-a-number' as any, FIXTURES.SECRET, { now: FIXTURES.TIMESTAMP });
        const result3 = verifyWebhookSignature(FIXTURES.PAYLOAD, validSignature, Infinity, FIXTURES.SECRET, { now: FIXTURES.TIMESTAMP });
        
        expect(result1.valid).toBe(false);
        expect(result1.code).toBe(WEBHOOK_VERIFICATION_CODES.INVALID_TIMESTAMP);
        expect(result2.valid).toBe(false);
        expect(result2.code).toBe(WEBHOOK_VERIFICATION_CODES.INVALID_TIMESTAMP);
        expect(result3.valid).toBe(false);
        expect(result3.code).toBe(WEBHOOK_VERIFICATION_CODES.INVALID_TIMESTAMP);
      });

      it('should accept timestamps within the allowed window', () => {
        const result = verifyWebhookSignature(
          FIXTURES.PAYLOAD,
          validSignature,
          FIXTURES.TIMESTAMP,
          FIXTURES.SECRET,
          { now: FIXTURES.TIMESTAMP + WEBHOOK_SIGNATURE_MAX_AGE_MS - 1 }
        );
        
        expect(result.valid).toBe(true);
      });
    });

    describe('signature format validation', () => {
      it('should reject short signatures', () => {
        const shortSig = 'a'.repeat(WEBHOOK_SIGNATURE_HEX_LENGTH - 1);
        const result = verifyWebhookSignature(FIXTURES.PAYLOAD, shortSig, FIXTURES.TIMESTAMP, FIXTURES.SECRET, { now: FIXTURES.TIMESTAMP });
        
        expect(result.valid).toBe(false);
        expect(result.code).toBe(WEBHOOK_VERIFICATION_CODES.INVALID_SIGNATURE_FORMAT);
      });

      it('should reject non-hex signatures', () => {
        const invalidSig = 'g'.repeat(WEBHOOK_SIGNATURE_HEX_LENGTH);
        const result = verifyWebhookSignature(FIXTURES.PAYLOAD, invalidSig, FIXTURES.TIMESTAMP, FIXTURES.SECRET, { now: FIXTURES.TIMESTAMP });
        
        expect(result.valid).toBe(false);
        expect(result.code).toBe(WEBHOOK_VERIFICATION_CODES.INVALID_SIGNATURE_FORMAT);
      });

      it('should never throw on malformed inputs', () => {
        expect(() => verifyWebhookSignature(FIXTURES.PAYLOAD, null, FIXTURES.TIMESTAMP, FIXTURES.SECRET)).not.toThrow();
        expect(() => verifyWebhookSignature(FIXTURES.PAYLOAD, undefined, FIXTURES.TIMESTAMP, FIXTURES.SECRET)).not.toThrow();
        expect(() => verifyWebhookSignature(FIXTURES.PAYLOAD, {}, FIXTURES.TIMESTAMP, FIXTURES.SECRET)).not.toThrow();
      });
    });

    describe('secret validation', () => {
      it('should reject missing/empty secrets', () => {
        const result1 = verifyWebhookSignature(FIXTURES.PAYLOAD, validSignature, FIXTURES.TIMESTAMP, '');
        const result2 = verifyWebhookSignature(FIXTURES.PAYLOAD, validSignature, FIXTURES.TIMESTAMP, null);
        const result3 = verifyWebhookSignature(FIXTURES.PAYLOAD, validSignature, FIXTURES.TIMESTAMP, undefined);
        
        expect(result1.valid).toBe(false);
        expect(result1.code).toBe(WEBHOOK_VERIFICATION_CODES.MISSING_SECRET);
        expect(result2.valid).toBe(false);
        expect(result2.code).toBe(WEBHOOK_VERIFICATION_CODES.MISSING_SECRET);
        expect(result3.valid).toBe(false);
        expect(result3.code).toBe(WEBHOOK_VERIFICATION_CODES.MISSING_SECRET);
      });
    });
  });

  describe('verifySignature', () => {
    let validSignature: string;

    beforeEach(() => {
      validSignature = generateSignature(FIXTURES.PAYLOAD, FIXTURES.SECRET, FIXTURES.TIMESTAMP);
    });

    it('should return true for valid signatures', () => {
      const isValid = verifySignature(FIXTURES.PAYLOAD, validSignature, FIXTURES.TIMESTAMP, FIXTURES.SECRET, { now: FIXTURES.TIMESTAMP });
      expect(isValid).toBe(true);
    });

    it('should return false for invalid signatures', () => {
      const isValid = verifySignature(FIXTURES.PAYLOAD, 'wrong-signature', FIXTURES.TIMESTAMP, FIXTURES.SECRET, { now: FIXTURES.TIMESTAMP });
      expect(isValid).toBe(false);
    });
  });
});
