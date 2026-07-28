/**
 * @module contracts.service.correlation.test
 * @description Tests for correlation ID propagation within ContractsService.
 *
 * Covers:
 *  - correlationId is threaded into structured log records for createContract,
 *    updateContract, and deleteContract
 *  - correlationId absent → no correlationId key in emitted records
 *  - Soroban failure still logs correlationId on the warning record
 *  - service still functions when correlationId is not provided (backward compat)
 */

import { ContractsService } from './contracts.service';
import { SorobanService } from './soroban.service';
import { ContractBoundsError } from '../contracts/bounds';
import { InMemoryContractRepository } from '../repositories/contractRepository';
import { setWriteRecordImpl } from '../logger';
import type { LogRecord } from '../logger';
import { NotFoundError } from '../errors/appError';

jest.mock('./soroban.service');

// ── helpers ───────────────────────────────────────────────────────────────────

const TEST_CORRELATION_ID = 'svc-test-corr-id-abc123';

async function captureLogRecords(fn: () => Promise<void>): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  setWriteRecordImpl((r) => records.push(r));
  try {
    await fn();
  } finally {
    // Restore default writer
    setWriteRecordImpl((record) => {
      const line = JSON.stringify(record);
      if (record.level === 'error') process.stderr.write(line + '\n');
      else process.stdout.write(line + '\n');
    });
  }
  return records;
}

const validCreateDto = {
  title: 'Test Contract',
  description: 'A test contract',
  clientId: '550e8400-e29b-41d4-a716-446655440000',
  budget: 1000,
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ContractsService – correlation ID propagation', () => {
  let service: ContractsService;
  let repository: InMemoryContractRepository;
  let mockSoroban: jest.Mocked<SorobanService>;

  beforeEach(() => {
    repository = new InMemoryContractRepository();
    service = new ContractsService(repository as any);
    mockSoroban = new SorobanService() as jest.Mocked<SorobanService>;
    (service as any).sorobanService = mockSoroban;
    mockSoroban.prepareEscrow = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── createContract ──────────────────────────────────────────────────────

  describe('createContract', () => {
    it('emits log records with correlationId when provided', async () => {
      const records = await captureLogRecords(async () => {
        await service.createContract(validCreateDto, TEST_CORRELATION_ID);
      });

      const creation = records.find(
        (r) => r.message === 'ContractsService.createContract: contract created',
      );
      expect(creation).toBeDefined();
      expect(creation?.correlationId).toBe(TEST_CORRELATION_ID);
    });

    it('emits log records WITHOUT correlationId when not provided', async () => {
      const records = await captureLogRecords(async () => {
        await service.createContract(validCreateDto);
      });

      const creation = records.find(
        (r) => r.message === 'ContractsService.createContract: contract created',
      );
      expect(creation).toBeDefined();
      expect(creation).not.toHaveProperty('correlationId');
    });

    it('soroban success log includes correlationId', async () => {
      const records = await captureLogRecords(async () => {
        await service.createContract(validCreateDto, TEST_CORRELATION_ID);
      });

      const sorobanLog = records.find(
        (r) => r.message === 'ContractsService.createContract: soroban escrow prepared',
      );
      expect(sorobanLog).toBeDefined();
      expect(sorobanLog?.correlationId).toBe(TEST_CORRELATION_ID);
    });

    it('soroban failure warning log includes correlationId', async () => {
      mockSoroban.prepareEscrow = jest.fn().mockRejectedValue(new Error('RPC down'));

      const records = await captureLogRecords(async () => {
        await service.createContract(validCreateDto, TEST_CORRELATION_ID);
      });

      const warn = records.find(
        (r) => r.message === 'ContractsService.createContract: soroban prepareEscrow failed',
      );
      expect(warn).toBeDefined();
      expect(warn?.level).toBe('warn');
      expect(warn?.correlationId).toBe(TEST_CORRELATION_ID);
    });

    it('soroban failure warning log has no correlationId when not provided', async () => {
      mockSoroban.prepareEscrow = jest.fn().mockRejectedValue(new Error('RPC down'));

      const records = await captureLogRecords(async () => {
        await service.createContract(validCreateDto);
      });

      const warn = records.find(
        (r) => r.message === 'ContractsService.createContract: soroban prepareEscrow failed',
      );
      expect(warn).toBeDefined();
      expect(warn).not.toHaveProperty('correlationId');
    });

    it('still creates contract when correlationId is undefined', async () => {
      const contract = await service.createContract(validCreateDto, undefined);
      expect(contract).toHaveProperty('id');
      expect(contract.title).toBe(validCreateDto.title);
    });

    it('correlationId does not appear in thrown ContractBoundsError', async () => {
      await expect(
        service.createContract(
          { ...validCreateDto, budget: -1 },
          TEST_CORRELATION_ID,
        ),
      ).rejects.toBeInstanceOf(ContractBoundsError);
    });
  });

  // ── updateContract ──────────────────────────────────────────────────────

  describe('updateContract', () => {
    it('emits log record with correlationId on successful update', async () => {
      // Pre-create a contract to update
      const created = await service.createContract(validCreateDto);

      const records = await captureLogRecords(async () => {
        await service.updateContract(
          created.id,
          { version: 0, title: 'Updated Title' },
          TEST_CORRELATION_ID,
        );
      });

      const updateLog = records.find(
        (r) => r.message === 'ContractsService.updateContract: contract updated',
      );
      expect(updateLog).toBeDefined();
      expect(updateLog?.correlationId).toBe(TEST_CORRELATION_ID);
      expect(updateLog?.contractId).toBe(created.id);
    });

    it('emits log record WITHOUT correlationId when not provided', async () => {
      const created = await service.createContract(validCreateDto);

      const records = await captureLogRecords(async () => {
        await service.updateContract(created.id, { version: 0, title: 'Updated' });
      });

      const updateLog = records.find(
        (r) => r.message === 'ContractsService.updateContract: contract updated',
      );
      expect(updateLog).toBeDefined();
      expect(updateLog).not.toHaveProperty('correlationId');
    });

    it('still updates contract when correlationId is undefined', async () => {
      const created = await service.createContract(validCreateDto);
      const updated = await service.updateContract(
        created.id,
        { version: 0, title: 'New Title' },
        undefined,
      );
      expect(updated.title).toBe('New Title');
    });
  });

  // ── deleteContract ──────────────────────────────────────────────────────

  describe('deleteContract', () => {
    it('emits log record with correlationId on successful delete', async () => {
      const created = await service.createContract(validCreateDto);

      const records = await captureLogRecords(async () => {
        await service.deleteContract(created.id, TEST_CORRELATION_ID);
      });

      const deleteLog = records.find(
        (r) => r.message === 'ContractsService.deleteContract: contract deleted',
      );
      expect(deleteLog).toBeDefined();
      expect(deleteLog?.correlationId).toBe(TEST_CORRELATION_ID);
      expect(deleteLog?.contractId).toBe(created.id);
    });

    it('emits log record WITHOUT correlationId when not provided', async () => {
      const created = await service.createContract(validCreateDto);

      const records = await captureLogRecords(async () => {
        await service.deleteContract(created.id);
      });

      const deleteLog = records.find(
        (r) => r.message === 'ContractsService.deleteContract: contract deleted',
      );
      expect(deleteLog).toBeDefined();
      expect(deleteLog).not.toHaveProperty('correlationId');
    });

    it('throws NotFoundError (no log) when id does not exist', async () => {
      await expect(
        service.deleteContract('non-existent', TEST_CORRELATION_ID),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('still deletes contract when correlationId is undefined', async () => {
      const created = await service.createContract(validCreateDto);
      // Should not throw
      await expect(
        service.deleteContract(created.id, undefined),
      ).resolves.toBeUndefined();
    });
  });

  // ── backward compatibility (no correlationId param) ─────────────────────

  describe('backward compatibility', () => {
    it('createContract works with zero extra args (pre-existing callers)', async () => {
      // Callers that have not been updated yet call createContract with one arg.
      const contract = await (service.createContract as (d: typeof validCreateDto) => Promise<any>)(validCreateDto);
      expect(contract).toHaveProperty('id');
    });

    it('deleteContract works with one arg (pre-existing callers)', async () => {
      const created = await service.createContract(validCreateDto);
      await expect(
        (service.deleteContract as (id: string) => Promise<void>)(created.id),
      ).resolves.toBeUndefined();
    });
  });
});
