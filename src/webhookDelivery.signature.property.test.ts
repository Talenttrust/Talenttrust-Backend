/**
 * Property-based / fuzz tests for inbound webhook HMAC verification.
 * Imports through webhookDelivery re-exports (issue #277).
 */

import { timingSafeEqual } from 'crypto';
import { containsUnsafeContent } from './errors/safeErrors';
import {
  WEBHOOK_SIGNATURE_HEX_LENGTH,
  constantTimeCompareHex,
  generateSignature,
  verifyWebhookSignature,
} from './utils/webhook-signing.util';
import {
  createSeededRng,
  randomAscii,
  randomBytesHex,
  randomInt,
} from './utils/webhook-signing.fuzz';

/** Fixed seed — fuzz suite must stay deterministic across CI runs. */
const FUZZ_SEED = 0x277a11ce;
const FUZZ_ITERATIONS = 400;

describe('webhookDelivery HMAC verification — property tests', () => {
  const secret = 'property-test-webhook-secret';
  const payload = { event: 'fuzz.case', data: { id: 'x', nested: [1, 2, null] } };
  const now = 1_700_000_000_000;

  describe('deterministic fuzz (fixed seed)', () => {
    it('rejects all forged signatures without throwing', () => {
      const rng = createSeededRng(FUZZ_SEED);
      const timestamp = now;
      const validHex = generateSignature(payload, secret, timestamp);

      for (let i = 0; i < FUZZ_ITERATIONS; i++) {
        const roll = randomInt(rng, 0, 11);
        let forgedSignature: unknown;
        let forgedTimestamp: unknown = timestamp;
        let forgedPayload: unknown = payload;
        let forgedSecret: unknown = secret;

        switch (roll) {
          case 0:
            forgedSignature = randomBytesHex(rng, randomInt(rng, 1, 40));
            break;
          case 1:
            forgedSignature = validHex.slice(0, randomInt(rng, 1, WEBHOOK_SIGNATURE_HEX_LENGTH - 1));
            break;
          case 2:
            forgedSignature = validHex + randomAscii(rng, randomInt(rng, 1, 8));
            break;
          case 3:
            forgedSignature = `sha256=${randomBytesHex(rng, 32)}`;
            break;
          case 4:
            forgedSignature = `sha256=${validHex.toUpperCase().slice(0, 32)}ff`;
            break;
          case 5:
            forgedSignature = randomAscii(rng, randomInt(rng, 0, 128));
            break;
          case 6:
            forgedSignature = Buffer.from(randomBytesHex(rng, 32), 'hex').toString('base64');
            break;
          case 7:
            forgedTimestamp = now - 6 * 60 * 1000;
            forgedSignature = generateSignature(payload, secret, forgedTimestamp as number);
            break;
          case 8:
            forgedTimestamp = NaN;
            forgedSignature = validHex;
            break;
          case 9:
            forgedSecret = `wrong-${randomAscii(rng, 8)}`;
            forgedSignature = validHex;
            break;
          case 10:
            forgedPayload = { ...payload, tampered: randomInt(rng, 0, 99999) };
            forgedSignature = validHex;
            break;
          default:
            forgedSignature = null;
        }

        expect(() =>
          verifyWebhookSignature(
            forgedPayload,
            forgedSignature,
            forgedTimestamp,
            forgedSecret,
            { now },
          ),
        ).not.toThrow();

        const result = verifyWebhookSignature(
          forgedPayload,
          forgedSignature,
          forgedTimestamp,
          forgedSecret,
          { now },
        );

        expect(result.valid).toBe(false);
        expect(result.code).not.toBe('valid');
        expect(containsUnsafeContent(result.message)).toBe(false);
        expect(result.message.length).toBeGreaterThan(0);
      }
    });

    it('accepts only the legitimately signed payload for the same secret and timestamp', () => {
      const timestamp = now;
      const signature = generateSignature(payload, secret, timestamp);
      const result = verifyWebhookSignature(payload, signature, timestamp, secret, { now });
      expect(result.valid).toBe(true);
      expect(result.code).toBe('valid');
    });
  });

  describe('constant-time comparison', () => {
    it('uses crypto.timingSafeEqual for equal-length digests', () => {
      const spy = jest.spyOn(require('crypto'), 'timingSafeEqual');
      const a = 'a'.repeat(WEBHOOK_SIGNATURE_HEX_LENGTH);
      const b = 'b'.repeat(WEBHOOK_SIGNATURE_HEX_LENGTH);
      constantTimeCompareHex(a, b);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('performs a dummy timingSafeEqual when digest lengths differ', () => {
      const spy = jest.spyOn(require('crypto'), 'timingSafeEqual');
      constantTimeCompareHex('ab', 'abcd');
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('matches timingSafeEqual for two valid digests', () => {
      const digest = generateSignature(payload, secret, now);
      const left = Buffer.from(digest, 'hex');
      const right = Buffer.from(digest, 'hex');
      expect(constantTimeCompareHex(digest, digest)).toBe(timingSafeEqual(left, right));
    });
  });

  describe('safeErrors integration', () => {
    it('never returns raw secrets or signature material in messages', () => {
      const result = verifyWebhookSignature(payload, 'deadbeef', now, secret, { now });
      expect(result.message.toLowerCase()).not.toContain(secret.toLowerCase());
      expect(result.message).not.toMatch(/[a-f0-9]{32,}/i);
    });
  });
});
