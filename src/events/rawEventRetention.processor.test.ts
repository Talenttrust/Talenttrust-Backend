/**
 * Raw event retention processor tests.
 *
 * Covers the queue-facing contract:
 *  - valid payload → successful JobResult with a structured summary
 *  - invalid payload → `InvalidJobPayloadError` (terminal; not retried)
 *  - unknown payload fields rejected (strict schema)
 *  - structured log shape + correlation-id propagation
 */

import { processRawEventRetention, rawEventRetentionPayloadSchema } from './rawEventRetention.processor';
import { RawEventRetentionService } from './rawEventRetention';
import { InvalidJobPayloadError } from '../queue/queue-errors';
import { setWriteRecordImpl, type LogRecord } from '../logger';

const SUMMARY = {
  enabled: true,
  dryRun: false,
  scanned: 5,
  archived: 3,
  purged: 3,
  held: 1,
  deferred: 1,
  alreadyArchived: 0,
  failed: 0,
  byNetwork: { soroban: { scanned: 5, archived: 3, purged: 3, held: 1, deferred: 1, alreadyArchived: 0, failed: 0 } },
};

function fakeService(): RawEventRetentionService {
  return {
    run: jest.fn(async () => ({ ...SUMMARY })),
  } as unknown as RawEventRetentionService;
}

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

describe('processRawEventRetention', () => {
  it('returns a successful job result with the run summary', async () => {
    const service = fakeService();
    const result = await processRawEventRetention(
      { maxEvents: 50, network: 'soroban', dryRun: true },
      { service },
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('5 scanned, 3 archived');
    expect(result.data).toMatchObject({ scanned: 5, archived: 3 });
    expect(service.run).toHaveBeenCalledWith(
      expect.objectContaining({ maxEvents: 50, network: 'soroban', dryRun: true }),
    );
  });

  it('rejects an invalid payload with a terminal queue error', async () => {
    const service = fakeService();
    await expect(
      processRawEventRetention(
        { network: 'ethereum' },
        { service },
      ),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);
    expect(service.run).not.toHaveBeenCalled();
  });

  it('rejects unknown payload fields (strict schema)', () => {
    const parsed = rawEventRetentionPayloadSchema.safeParse({
      maxEvents: 10,
      unexpected: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('emits structured JSON logs with correlation ids', async () => {
    const { records, restore } = captureRecords();
    try {
      await processRawEventRetention(
        { correlationId: 'corr-1', requestId: 'req-1' },
        { service: fakeService() },
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
