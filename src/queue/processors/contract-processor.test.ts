/**
 * Contract Processor Tests
 *
 * Covers: structured log shape, contractId only in debug records, correlation
 * context propagation, and all validation / action branches.
 */

import { processContractProcessing } from './contract-processor';
import { ContractProcessingPayload } from '../types';
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

const BASE_PAYLOAD: ContractProcessingPayload = {
  contractId: 'contract_12345',
  action: 'create',
  metadata: { amount: 1000, currency: 'USD' },
};

// ── processContractProcessing ────────────────────────────────────────────────

describe('processContractProcessing', () => {
  describe('happy path', () => {
    it('creates a contract', async () => {
      const result = await processContractProcessing(BASE_PAYLOAD);
      expect(result.success).toBe(true);
      expect(result.message).toContain('created');
      expect((result.data as any).contractId).toBe(BASE_PAYLOAD.contractId);
      expect((result.data as any).status).toBe('active');
    });

    it('updates a contract', async () => {
      const result = await processContractProcessing({ ...BASE_PAYLOAD, action: 'update' });
      expect(result.success).toBe(true);
      expect(result.message).toContain('updated');
      expect((result.data as any)).toHaveProperty('metadata');
    });

    it('finalizes a contract', async () => {
      const result = await processContractProcessing({ ...BASE_PAYLOAD, action: 'finalize' });
      expect(result.success).toBe(true);
      expect(result.message).toContain('finalized');
      expect((result.data as any).status).toBe('completed');
    });

    it('handles complex metadata', async () => {
      const result = await processContractProcessing({
        contractId: 'contract_complex',
        action: 'create',
        metadata: {
          freelancer: 'user_123',
          client: 'user_456',
          milestones: [{ id: 1, amount: 500 }],
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('validation errors', () => {
    it('throws on short contractId', async () => {
      await expect(
        processContractProcessing({ ...BASE_PAYLOAD, contractId: 'short' }),
      ).rejects.toThrow('Invalid contract ID');
    });

    it('throws on empty contractId', async () => {
      await expect(
        processContractProcessing({ ...BASE_PAYLOAD, contractId: '' }),
      ).rejects.toThrow('Invalid contract ID');
    });

    it('throws on invalid action', async () => {
      await expect(
        processContractProcessing({ ...BASE_PAYLOAD, action: 'invalid-action' } as unknown as ContractProcessingPayload),
      ).rejects.toThrow('Unsupported action');
    });

    it('throws from switch default on unrecognised action bypassing TypeScript', async () => {
      // The switch default is the single validation point for unknown actions.
      // This test reaches it via a runtime cast to confirm the defensive branch
      // emits a structured warn and throws with the action name embedded.
      await expect(
        processContractProcessing({ ...BASE_PAYLOAD, action: 'delete' } as unknown as ContractProcessingPayload),
      ).rejects.toThrow('Unsupported action: delete');
    });
  });

  describe('structured log shape', () => {
    it('emits JSON records with required base fields', async () => {
      const { records, restore } = captureRecords();
      try {
        await processContractProcessing(BASE_PAYLOAD);
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

    it('includes action on every log record', async () => {
      const { records, restore } = captureRecords();
      try {
        await processContractProcessing({ ...BASE_PAYLOAD, action: 'update' });
      } finally {
        restore();
      }

      const infoRecords = records.filter((r) => r.level === 'info');
      for (const r of infoRecords) {
        expect(r.action).toBe('update');
      }
    });

    it('propagates correlationId and requestId', async () => {
      const { records, restore } = captureRecords();
      try {
        await processContractProcessing({
          ...BASE_PAYLOAD,
          correlationId: 'corr-con',
          requestId: 'req-con',
        });
      } finally {
        restore();
      }

      const infoRecords = records.filter((r) => r.level === 'info');
      expect(infoRecords.length).toBeGreaterThan(0);
      for (const r of infoRecords) {
        expect(r.correlationId).toBe('corr-con');
        expect(r.requestId).toBe('req-con');
      }
    });

    it('does not log contractId in info-level message strings', async () => {
      const { records, restore } = captureRecords();
      try {
        await processContractProcessing(BASE_PAYLOAD);
      } finally {
        restore();
      }

      const infoRecords = records.filter((r) => r.level === 'info');
      for (const r of infoRecords) {
        // contractId must not be embedded in the message field at info level
        expect(r.message).not.toContain(BASE_PAYLOAD.contractId);
      }
    });

    it('emits a warn record on validation failure, not console.warn', async () => {
      const { records, restore } = captureRecords();
      try {
        await processContractProcessing({ ...BASE_PAYLOAD, contractId: 'x' }).catch(() => {/*expected*/});
      } finally {
        restore();
      }

      const warnRecords = records.filter((r) => r.level === 'warn');
      expect(warnRecords.length).toBeGreaterThan(0);
    });

    it('all three action paths emit info-level completion records', async () => {
      for (const action of ['create', 'update', 'finalize'] as const) {
        const { records, restore } = captureRecords();
        try {
          await processContractProcessing({ ...BASE_PAYLOAD, action });
        } finally {
          restore();
        }

        const completion = records.find(
          (r) => r.level === 'info' && (r.action === action),
        );
        expect(completion).toBeDefined();
      }
    });

    it('switch default emits a structured warn record on unknown action', async () => {
      const { records, restore } = captureRecords();
      try {
        await processContractProcessing({
          ...BASE_PAYLOAD,
          action: 'delete',
        } as unknown as ContractProcessingPayload).catch(() => {/*expected*/});
      } finally {
        restore();
      }

      const warnRecords = records.filter((r) => r.level === 'warn');
      expect(warnRecords.length).toBeGreaterThan(0);
      const defaultWarn = warnRecords.find(
        (r) => typeof r.message === 'string' && r.message.includes('unsupported action'),
      );
      expect(defaultWarn).toBeDefined();
    });
  });
});
