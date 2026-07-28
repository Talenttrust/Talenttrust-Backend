/**
 * Reputation Processor Tests
 *
 * Covers: structured log shape, PII redaction (userId not in info messages),
 * correlation context propagation, and all validation branches.
 */

import { processReputationUpdate } from './reputation-processor';
import { ReputationUpdatePayload } from '../types';
import { setWriteRecordImpl, LogRecord } from '../../logger';

// ── helpers ───────────────────────────────────────────────────────────────────

function captureRecords(): { records: LogRecord[]; restore: () => void } {
  const records: LogRecord[] = [];
  setWriteRecordImpl((r) => records.push(r));
  return {
    records,
    restore: () =>
      setWriteRecordImpl((r: LogRecord) => {
        const line = JSON.stringify(r);
        (r.level === 'error' ? process.stderr : process.stdout).write(line + '\n');
      }),
  };
}

const BASE_PAYLOAD: ReputationUpdatePayload = {
  userId: 'user_12345',
  contractId: 'contract_67890',
  rating: 5,
  feedback: 'Excellent work!',
};

// ── processReputationUpdate ──────────────────────────────────────────────────

describe('processReputationUpdate', () => {
  describe('happy path', () => {
    it('processes a valid reputation update', async () => {
      const result = await processReputationUpdate(BASE_PAYLOAD);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Reputation updated');
      expect((result.data as any).userId).toBe(BASE_PAYLOAD.userId);
      expect(typeof (result.data as any).newScore).toBe('number');
    });

    it('processes without feedback', async () => {
      const result = await processReputationUpdate({ ...BASE_PAYLOAD, feedback: undefined });
      expect(result.success).toBe(true);
    });

    it('produces monotonically increasing scores for ratings 1-5', async () => {
      const scores: number[] = [];
      for (const rating of [1, 2, 3, 4, 5]) {
        const result = await processReputationUpdate({ ...BASE_PAYLOAD, rating });
        scores.push((result.data as any).newScore);
      }
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
      }
    });
  });

  describe('validation errors', () => {
    it('throws on short userId', async () => {
      await expect(
        processReputationUpdate({ ...BASE_PAYLOAD, userId: 'usr' }),
      ).rejects.toThrow('Invalid user ID');
    });

    it('throws on rating below minimum', async () => {
      await expect(
        processReputationUpdate({ ...BASE_PAYLOAD, rating: 0 }),
      ).rejects.toThrow('Rating must be between 1 and 5');
    });

    it('throws on rating above maximum', async () => {
      await expect(
        processReputationUpdate({ ...BASE_PAYLOAD, rating: 6 }),
      ).rejects.toThrow('Rating must be between 1 and 5');
    });

    it('throws on missing contractId', async () => {
      await expect(
        processReputationUpdate({ ...BASE_PAYLOAD, contractId: '' }),
      ).rejects.toThrow('Contract ID is required');
    });
  });

  describe('structured log shape', () => {
    it('emits JSON records with required base fields', async () => {
      const { records, restore } = captureRecords();
      try {
        await processReputationUpdate(BASE_PAYLOAD);
      } finally {
        restore();
      }

      expect(records.length).toBeGreaterThan(0);
      for (const r of records) {
        expect(r).toHaveProperty('timestamp');
        expect(r).toHaveProperty('level');
        expect(r).toHaveProperty('message');
        expect(r).toHaveProperty('service', 'talenttrust-backend');
      }
    });

    it('propagates correlationId and requestId', async () => {
      const { records, restore } = captureRecords();
      try {
        await processReputationUpdate({
          ...BASE_PAYLOAD,
          correlationId: 'corr-rep',
          requestId: 'req-rep',
        });
      } finally {
        restore();
      }

      const infoRecords = records.filter((r) => r.level === 'info');
      expect(infoRecords.length).toBeGreaterThan(0);
      for (const r of infoRecords) {
        expect(r.correlationId).toBe('corr-rep');
        expect(r.requestId).toBe('req-rep');
      }
    });

    it('does not include userId in info-level message strings', async () => {
      const { records, restore } = captureRecords();
      try {
        await processReputationUpdate(BASE_PAYLOAD);
      } finally {
        restore();
      }

      const infoRecords = records.filter((r) => r.level === 'info');
      for (const r of infoRecords) {
        // message field must not embed userId
        expect(r.message).not.toContain(BASE_PAYLOAD.userId);
      }
    });

    it('includes newScore in the completion info record', async () => {
      const { records, restore } = captureRecords();
      try {
        await processReputationUpdate(BASE_PAYLOAD);
      } finally {
        restore();
      }

      const stored = records.find(
        (r) => r.level === 'info' && typeof r.message === 'string' && r.message.includes('stored'),
      );
      expect(stored).toBeDefined();
      expect(typeof stored!.newScore).toBe('number');
    });

    it('emits warn record (not console.warn) on validation failure', async () => {
      const { records, restore } = captureRecords();
      try {
        await processReputationUpdate({ ...BASE_PAYLOAD, rating: 0 }).catch(() => {/*expected*/});
      } finally {
        restore();
      }

      const warnRecords = records.filter((r) => r.level === 'warn');
      expect(warnRecords.length).toBeGreaterThan(0);
    });
  });
});
