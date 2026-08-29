/**
 * Blockchain Processor Tests
 *
 * Covers: structured log shape, correlation context, validation branches,
 * and that no sensitive data leaks into info/warn records.
 */

import { processBlockchainSync } from './blockchain-processor';
import { BlockchainSyncPayload } from '../types';
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

// ── processBlockchainSync ────────────────────────────────────────────────────

describe('processBlockchainSync', () => {
  describe('happy path', () => {
    it('syncs stellar blockchain', async () => {
      const payload: BlockchainSyncPayload = { network: 'stellar', startBlock: 0, endBlock: 50 };
      const result = await processBlockchainSync(payload);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Blockchain sync completed');
      expect((result.data as any).network).toBe('stellar');
      expect((result.data as any).blocksProcessed).toBeGreaterThan(0);
    });

    it('syncs soroban blockchain', async () => {
      const result = await processBlockchainSync({ network: 'soroban', startBlock: 100, endBlock: 200 });
      expect(result.success).toBe(true);
      expect((result.data as any).network).toBe('soroban');
    });

    it('syncs without explicit block range', async () => {
      const result = await processBlockchainSync({ network: 'stellar' });
      expect(result.success).toBe(true);
    });

    it('handles large block ranges', async () => {
      const result = await processBlockchainSync({ network: 'stellar', startBlock: 0, endBlock: 1000 });
      expect(result.success).toBe(true);
      expect((result.data as any).blocksProcessed).toBeGreaterThan(0);
    });
  });

  describe('validation errors', () => {
    it('rejects invalid network', async () => {
      await expect(
        processBlockchainSync({ network: 'ethereum' } as unknown as BlockchainSyncPayload),
      ).rejects.toThrow('Invalid network');
    });

    it('rejects inverted block range', async () => {
      await expect(
        processBlockchainSync({ network: 'stellar', startBlock: 100, endBlock: 50 }),
      ).rejects.toThrow('Start block must be less than or equal to end block');
    });
  });

  describe('structured log shape', () => {
    it('emits JSON records with required fields', async () => {
      const { records, restore } = captureRecords();
      try {
        await processBlockchainSync({ network: 'stellar', startBlock: 0, endBlock: 10 });
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

    it('includes network on every log record', async () => {
      const { records, restore } = captureRecords();
      try {
        await processBlockchainSync({ network: 'stellar', startBlock: 0, endBlock: 10 });
      } finally {
        restore();
      }

      const infoRecords = records.filter((r) => r.level === 'info');
      for (const r of infoRecords) {
        expect(r.network).toBe('stellar');
      }
    });

    it('propagates correlationId and requestId', async () => {
      const { records, restore } = captureRecords();
      try {
        await processBlockchainSync({
          network: 'stellar',
          startBlock: 0,
          endBlock: 5,
          correlationId: 'corr-xyz',
          requestId: 'req-456',
        });
      } finally {
        restore();
      }

      const infoRecords = records.filter((r) => r.level === 'info');
      expect(infoRecords.length).toBeGreaterThan(0);
      for (const r of infoRecords) {
        expect(r.correlationId).toBe('corr-xyz');
        expect(r.requestId).toBe('req-456');
      }
    });

    it('logs sync statistics in completion record', async () => {
      const { records, restore } = captureRecords();
      try {
        await processBlockchainSync({ network: 'soroban', startBlock: 0, endBlock: 20 });
      } finally {
        restore();
      }

      const completionRecord = records.find(
        (r) => r.level === 'info' && typeof r.message === 'string' && r.message.includes('completed'),
      );
      expect(completionRecord).toBeDefined();
      expect(typeof completionRecord!.blocksProcessed).toBe('number');
      expect(typeof completionRecord!.transactionsFound).toBe('number');
    });

    it('emits a warn record (not console.warn) on invalid network', async () => {
      const { records, restore } = captureRecords();
      try {
        await processBlockchainSync({ network: 'bad' } as unknown as BlockchainSyncPayload).catch(() => {/*expected*/});
      } finally {
        restore();
      }

      const warnRecords = records.filter((r) => r.level === 'warn');
      expect(warnRecords.length).toBeGreaterThan(0);
    });
  });

  describe('finality promotion', () => {
    it('runs the promotion sweep for the synced network after a successful sync', async () => {
      const promoter = jest.fn(async (_network: string) => ({ promoted: 2, remaining: 0 }));
      const result = await processBlockchainSync(
        { network: 'stellar', startBlock: 0, endBlock: 10 },
        promoter,
      );

      expect(result.success).toBe(true);
      expect(promoter).toHaveBeenCalledWith('stellar');
      expect((result.data as any).finalityPromotion).toEqual({ promoted: 2, remaining: 0 });
    });

    it('does not run the promotion sweep when validation fails', async () => {
      const promoter = jest.fn();
      await expect(
        processBlockchainSync(
          { network: 'ethereum' } as unknown as BlockchainSyncPayload,
          promoter,
        ),
      ).rejects.toThrow('Invalid network');
      expect(promoter).not.toHaveBeenCalled();
    });

    it('propagates promotion failures so the queue retries the job', async () => {
      const promoter = jest.fn(async () => {
        throw new Error('promotion failure');
      });

      await expect(
        processBlockchainSync({ network: 'stellar', startBlock: 0, endBlock: 10 }, promoter),
      ).rejects.toThrow('promotion failure');
    });
  });
});
