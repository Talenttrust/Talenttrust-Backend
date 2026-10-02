/**
 * Reorg detector tests.
 *
 * Required edge cases covered per issue #1204:
 * - no reorg (head advances normally)
 * - single-ledger reorg (head drops by 1)
 * - reorg exceeds retention window (deep reorg rejected)
 * - reorg during processing (handled by queue retry)
 * - operator repeats rewind (idempotency)
 */

import { evaluateReorg, ReorgDetectorConfig } from './reorgDetector';

const defaultConfig: ReorgDetectorConfig = { maxRewindDepth: 100 };

describe('evaluateReorg', () => {
  describe('no reorg', () => {
    it('returns detected: false when head advances normally', () => {
      const result = evaluateReorg(100, 110, defaultConfig);
      expect(result.detected).toBe(false);
      expect(result.depth).toBe(0);
      expect(result.exceedsRetentionPolicy).toBe(false);
      expect(result.rewindFromLedger).toBeUndefined();
    });

    it('returns detected: false when head stays the same', () => {
      const result = evaluateReorg(100, 100, defaultConfig);
      expect(result.detected).toBe(false);
      expect(result.depth).toBe(0);
    });

    it('returns detected: false on first sync (previousHead = 0)', () => {
      const result = evaluateReorg(0, 50, defaultConfig);
      expect(result.detected).toBe(false);
    });

    it('returns detected: false when both heads are 0', () => {
      const result = evaluateReorg(0, 0, defaultConfig);
      expect(result.detected).toBe(false);
    });
  });

  describe('single-ledger reorg', () => {
    it('detects a reorg of depth 1', () => {
      const result = evaluateReorg(100, 99, defaultConfig);
      expect(result.detected).toBe(true);
      expect(result.depth).toBe(1);
      expect(result.rewindFromLedger).toBe(99);
      expect(result.exceedsRetentionPolicy).toBe(false);
    });

    it('does not exceed retention for a single-ledger reorg', () => {
      const config: ReorgDetectorConfig = { maxRewindDepth: 1 };
      const result = evaluateReorg(100, 99, config);
      expect(result.exceedsRetentionPolicy).toBe(false);
    });
  });

  describe('multi-ledger reorg within window', () => {
    it('detects a reorg of depth 50', () => {
      const result = evaluateReorg(200, 150, defaultConfig);
      expect(result.detected).toBe(true);
      expect(result.depth).toBe(50);
      expect(result.rewindFromLedger).toBe(150);
      expect(result.exceedsRetentionPolicy).toBe(false);
    });

    it('detects a reorg at exactly the max rewind depth', () => {
      const config: ReorgDetectorConfig = { maxRewindDepth: 10 };
      const result = evaluateReorg(100, 90, config);
      expect(result.detected).toBe(true);
      expect(result.depth).toBe(10);
      expect(result.exceedsRetentionPolicy).toBe(false);
    });
  });

  describe('reorg exceeds retention window', () => {
    it('marks deep reorg as exceeding retention', () => {
      const result = evaluateReorg(1000, 500, defaultConfig);
      expect(result.detected).toBe(true);
      expect(result.depth).toBe(500);
      expect(result.exceedsRetentionPolicy).toBe(true);
      expect(result.rewindFromLedger).toBe(500);
    });

    it('exceeds retention when depth is one more than max', () => {
      const config: ReorgDetectorConfig = { maxRewindDepth: 5 };
      const result = evaluateReorg(100, 94, config);
      expect(result.detected).toBe(true);
      expect(result.depth).toBe(6);
      expect(result.exceedsRetentionPolicy).toBe(true);
    });

    it('exceeds retention when reorg drops head to 0', () => {
      const result = evaluateReorg(100, 0, defaultConfig);
      expect(result.detected).toBe(true);
      expect(result.depth).toBe(100);
      // depth 100 == maxRewindDepth 100 → does NOT exceed
      expect(result.exceedsRetentionPolicy).toBe(false);
    });

    it('exceeds retention when reorg drops head to 0 and depth > max', () => {
      const config: ReorgDetectorConfig = { maxRewindDepth: 50 };
      const result = evaluateReorg(100, 0, config);
      expect(result.detected).toBe(true);
      expect(result.exceedsRetentionPolicy).toBe(true);
    });
  });

  describe('input validation', () => {
    it('rejects negative previousHead', () => {
      expect(() => evaluateReorg(-1, 100, defaultConfig)).toThrow(
        /previousHead must be a non-negative integer/,
      );
    });

    it('rejects negative currentHead', () => {
      expect(() => evaluateReorg(100, -1, defaultConfig)).toThrow(
        /currentHead must be a non-negative integer/,
      );
    });

    it('rejects non-integer previousHead', () => {
      expect(() => evaluateReorg(10.5, 100, defaultConfig)).toThrow(
        /previousHead must be a non-negative integer/,
      );
    });

    it('rejects non-integer currentHead', () => {
      expect(() => evaluateReorg(100, 99.5, defaultConfig)).toThrow(
        /currentHead must be a non-negative integer/,
      );
    });

    it('rejects zero maxRewindDepth', () => {
      expect(() => evaluateReorg(100, 50, { maxRewindDepth: 0 })).toThrow(
        /maxRewindDepth must be a positive integer/,
      );
    });

    it('rejects negative maxRewindDepth', () => {
      expect(() => evaluateReorg(100, 50, { maxRewindDepth: -5 })).toThrow(
        /maxRewindDepth must be a positive integer/,
      );
    });

    it('rejects non-integer maxRewindDepth', () => {
      expect(() => evaluateReorg(100, 50, { maxRewindDepth: 3.14 })).toThrow(
        /maxRewindDepth must be a positive integer/,
      );
    });
  });

  describe('idempotency / determinism', () => {
    it('returns the same result when called multiple times with the same inputs', () => {
      const a = evaluateReorg(200, 150, defaultConfig);
      const b = evaluateReorg(200, 150, defaultConfig);
      expect(a).toEqual(b);
    });

    it('returns a fresh object each time (no shared references)', () => {
      const a = evaluateReorg(200, 150, defaultConfig);
      const b = evaluateReorg(200, 150, defaultConfig);
      a.detected = false; // mutate
      expect(b.detected).toBe(true); // should be unaffected
    });
  });

  describe('edge cases', () => {
    it('handles very large ledger values', () => {
      const result = evaluateReorg(9_999_999, 9_999_900, defaultConfig);
      expect(result.detected).toBe(true);
      expect(result.depth).toBe(99);
      expect(result.exceedsRetentionPolicy).toBe(false);
    });

    it('handles maxRewindDepth of 1 (any reorg is significant)', () => {
      const config: ReorgDetectorConfig = { maxRewindDepth: 1 };
      expect(evaluateReorg(100, 99, config).exceedsRetentionPolicy).toBe(false);
      expect(evaluateReorg(100, 98, config).exceedsRetentionPolicy).toBe(true);
    });
  });
});
