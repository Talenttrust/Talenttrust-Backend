/**
 * Milestone divergence scan processor tests.
 *
 * Covers the queue-facing contract:
 *  - valid payload → successful JobResult with a summary
 *  - invalid payload → `InvalidJobPayloadError` (terminal; not retried)
 *  - head-ledger failure → error propagates so the queue retries
 *  - structured log shape + correlation-id propagation
 */

import {
  processMilestoneDivergenceScan,
  milestoneDivergenceScanPayloadSchema,
} from './processor';
import { MilestoneDivergenceScanner } from './scanner';
import type { MilestoneDivergenceScanPayload, DivergenceScanSummary } from './types';
import { InvalidJobPayloadError } from '../../queue/queue-errors';
import { setWriteRecordImpl, type LogRecord } from '../../logger';

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

const SUMMARY: DivergenceScanSummary = {
  runId: 'run-1',
  tenantId: 'default',
  blockHeight: 100,
  contractsScanned: 3,
  inSync: 2,
  divergent: 1,
  unavailable: 0,
};

function fakeScanner(): MilestoneDivergenceScanner {
  return {
    run: jest.fn(async () => ({ ...SUMMARY })),
  } as unknown as MilestoneDivergenceScanner;
}

describe('processMilestoneDivergenceScan', () => {
  it('returns a successful job result with the scan summary', async () => {
    const scanner = fakeScanner();
    const result = await processMilestoneDivergenceScan(
      { maxContracts: 50, tenantId: 'tenant-a' },
      { scanner },
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('3 contract(s) compared');
    expect(result.data).toMatchObject({ divergent: 1, contractsScanned: 3 });
    expect(scanner.run).toHaveBeenCalledWith(
      expect.objectContaining({ maxContracts: 50, tenantId: 'tenant-a' }),
    );
  });

  it('rejects an invalid payload with a terminal queue error', async () => {
    const scanner = fakeScanner();
    await expect(
      processMilestoneDivergenceScan(
        { maxContracts: 1_000_000 } as unknown as MilestoneDivergenceScanPayload,
        { scanner },
      ),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);
    expect(scanner.run).not.toHaveBeenCalled();
  });

  it('rejects unknown payload fields (strict schema)', () => {
    const parsed = milestoneDivergenceScanPayloadSchema.safeParse({
      maxContracts: 10,
      unexpected: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('propagates head-ledger failures so the queue retries', async () => {
    const scanner = {
      run: jest.fn(async () => {
        throw new Error('head ledger unavailable');
      }),
    } as unknown as MilestoneDivergenceScanner;

    await expect(
      processMilestoneDivergenceScan({ tenantId: 't' }, { scanner }),
    ).rejects.toThrow('head ledger unavailable');
  });

  it('emits structured JSON logs with correlation ids', async () => {
    const { records, restore } = captureRecords();
    try {
      await processMilestoneDivergenceScan(
        { correlationId: 'corr-1', requestId: 'req-1' },
        { scanner: fakeScanner() },
      );
    } finally {
      restore();
    }

    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r).toHaveProperty('timestamp');
      expect(r).toHaveProperty('level');
      expect(r).toHaveProperty('message');
      expect(r).toHaveProperty('service', 'talenttrust-backend');
      expect(r.correlationId).toBe('corr-1');
      expect(r.requestId).toBe('req-1');
    }
  });
});
