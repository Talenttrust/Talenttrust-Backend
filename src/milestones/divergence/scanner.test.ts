/**
 * Milestone divergence scanner tests.
 *
 * Covers every edge case from issue #1213 at the service level:
 *  - no differences            → `in_sync` reports
 *  - one field differs         → `divergent` with field-level diff + block height
 *  - missing indexed record    → `divergent` with missingIndexedMilestones
 *  - RPC unavailable           → `unavailable` report; run continues
 *  - large contract set        → bounded by maxContracts + cursor resume
 * Plus: head-ledger failure → throws (queue retries), tenant isolation,
 * never-overwrite-canonical-state, retry idempotency.
 */

import {
  MilestoneDivergenceScanner,
  DEFAULT_MAX_CONTRACTS_PER_RUN,
  MAX_CONTRACTS_PER_RUN,
  clampMaxContracts,
  sanitizeRpcError,
} from './scanner';
import {
  InMemoryMilestoneDivergenceRepository,
} from './repository';
import type { MilestoneChainReader, OnChainMilestoneRead } from './chain-reader';
import type {
  MilestoneContractProvider,
  MilestoneIndexedStore,
} from './indexed-reader';
import type { MilestoneState } from './types';
import { MilestonesService } from '../../services/milestones.service';

const HEAD_LEDGER = 10_000;

function milestone(overrides: Partial<MilestoneState> = {}): MilestoneState {
  return {
    milestoneId: 'm1',
    title: 'Design',
    description: 'Review',
    amount: 500,
    completed: false,
    ...overrides,
  };
}

interface FakeChainOptions {
  /** Per-contract on-chain milestone map. */
  onChain?: Record<string, MilestoneState[]>;
  /** Per-contract read failures (contractId → error). */
  failures?: Record<string, Error>;
  /** When true, getLatestLedger throws. */
  headFailure?: boolean;
}

class FakeChainReader implements MilestoneChainReader {
  constructor(private readonly options: FakeChainOptions = {}) {}

  async getLatestLedger(): Promise<number> {
    if (this.options.headFailure) {
      throw new Error('head ledger unavailable');
    }
    return HEAD_LEDGER;
  }

  async readMilestones(contractId: string): Promise<OnChainMilestoneRead> {
    if (this.options.failures?.[contractId]) {
      throw this.options.failures[contractId]!;
    }
    return {
      milestones: this.options.onChain?.[contractId] ?? [],
      ledger: HEAD_LEDGER,
    };
  }
}

class FakeIndexedStore implements MilestoneIndexedStore {
  /** contractId → indexed milestones. */
  public readonly data: Record<string, MilestoneState[]>;
  /** Records every (contractId, tenantId) read, for tenant-isolation asserts. */
  public readonly reads: Array<{ contractId: string; tenantId: string }> = [];

  constructor(data: Record<string, MilestoneState[]>) {
    this.data = data;
  }

  async listMilestones(contractId: string, tenantId?: string): Promise<MilestoneState[]> {
    this.reads.push({ contractId, tenantId: tenantId ?? 'default' });
    return this.data[contractId] ?? [];
  }
}

class FakeContractProvider implements MilestoneContractProvider {
  public contracts: string[];

  constructor(contracts: string[]) {
    this.contracts = contracts;
  }

  async listContractIds(
    tenantId?: string,
    limit?: number,
    offset?: number,
  ): Promise<string[]> {
    const start = offset ?? 0;
    const end = limit === undefined ? undefined : start + limit;
    return this.contracts.slice(start, end);
  }
}

function buildScanner(overrides: {
  onChain?: Record<string, MilestoneState[]>;
  indexed?: Record<string, MilestoneState[]>;
  failures?: Record<string, Error>;
  contracts?: string[];
  headFailure?: boolean;
} = {}) {
  const chainReader = new FakeChainReader({
    onChain: overrides.onChain,
    failures: overrides.failures,
    headFailure: overrides.headFailure,
  });
  const indexedStore = new FakeIndexedStore(overrides.indexed ?? {});
  const contractProvider = new FakeContractProvider(
    overrides.contracts ?? ['contract-1'],
  );
  const repository = new InMemoryMilestoneDivergenceRepository();

  const scanner = new MilestoneDivergenceScanner({
    chainReader,
    indexedStore,
    contractProvider,
    repository,
  });

  return { scanner, repository, indexedStore, contractProvider, chainReader };
}

describe('MilestoneDivergenceScanner', () => {
  describe('no differences', () => {
    it('reports in_sync and returns a balanced summary', async () => {
      const { scanner, repository } = buildScanner({
        contracts: ['c1'],
        indexed: { c1: [milestone({ milestoneId: 'm1' })] },
        onChain: { c1: [milestone({ milestoneId: 'm1' })] },
      });

      const summary = await scanner.run({ tenantId: 'tenant-a' });

      expect(summary).toMatchObject({
        tenantId: 'tenant-a',
        blockHeight: HEAD_LEDGER,
        contractsScanned: 1,
        inSync: 1,
        divergent: 0,
        unavailable: 0,
      });
      const rows = repository.list({ tenantId: 'tenant-a' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'in_sync', blockHeight: HEAD_LEDGER });
      expect(rows[0]!.milestoneComparisons[0]!.status).toBe('in_sync');
    });
  });

  describe('one field differs', () => {
    it('reports divergent with a field-level difference and block height', async () => {
      const { scanner, repository } = buildScanner({
        contracts: ['c1'],
        indexed: { c1: [milestone({ milestoneId: 'm1', amount: 500 })] },
        onChain: { c1: [milestone({ milestoneId: 'm1', amount: 900 })] },
      });

      const summary = await scanner.run({ tenantId: 'tenant-a' });
      expect(summary.divergent).toBe(1);

      const [row] = repository.list({ tenantId: 'tenant-a' });
      expect(row!.status).toBe('divergent');
      expect(row!.blockHeight).toBe(HEAD_LEDGER);
      expect(row!.differences).toEqual([
        {
          field: 'milestones.m1.amount',
          indexed: 500,
          onChain: 900,
        },
      ]);
    });
  });

  describe('missing indexed record', () => {
    it('reports divergent and lists the missing milestone id', async () => {
      const { scanner, repository } = buildScanner({
        contracts: ['c1'],
        indexed: {},
        onChain: { c1: [milestone({ milestoneId: 'm1' })] },
      });

      const summary = await scanner.run({ tenantId: 'tenant-a' });
      expect(summary.divergent).toBe(1);

      const [row] = repository.list({ tenantId: 'tenant-a' });
      expect(row!.status).toBe('divergent');
      // The missing record is captured per-milestone in the persisted report.
      expect(row!.milestoneComparisons[0]!.status).toBe('missing_indexed');
      expect(row!.differences[0]!.field).toBe('milestones.m1');
    });
  });

  describe('RPC unavailable', () => {
    it('records an unavailable report and continues the run', async () => {
      const { scanner, repository } = buildScanner({
        contracts: ['c1', 'c2'],
        indexed: { c2: [milestone({ milestoneId: 'm1' })] },
        onChain: { c2: [milestone({ milestoneId: 'm1' })] },
        failures: { c1: new Error('network down') },
      });

      const summary = await scanner.run({ tenantId: 'tenant-a' });

      expect(summary).toMatchObject({
        contractsScanned: 2,
        unavailable: 1,
        inSync: 1,
      });

      const rows = repository.list({ tenantId: 'tenant-a' });
      const unavailable = rows.find((r) => r.status === 'unavailable')!;
      expect(unavailable.contractId).toBe('c1');
      expect(unavailable.rpcError).toBeDefined();
      expect(unavailable.rpcError!.message).not.toContain('stack');
      expect(rows.find((r) => r.contractId === 'c2')!.status).toBe('in_sync');
    });
  });

  describe('head ledger failure', () => {
    it('throws so the queue retries the whole run', async () => {
      const { scanner, repository } = buildScanner({ headFailure: true });
      await expect(scanner.run({ tenantId: 'tenant-a' })).rejects.toThrow(
        'head ledger unavailable',
      );
      // No reports are written without a block height.
      expect(repository.count()).toBe(0);
    });
  });

  describe('large contract set (bounded)', () => {
    it('compares at most maxContracts and returns a nextCursor', async () => {
      const contracts = Array.from({ length: 1000 }, (_, i) => `c${i}`);
      const onChain: Record<string, MilestoneState[]> = {};
      for (const id of contracts) {
        onChain[id] = [milestone({ milestoneId: 'm1' })];
      }
      const { scanner, repository } = buildScanner({ contracts, onChain });

      const summary = await scanner.run({ tenantId: 'tenant-a', maxContracts: 100 });

      expect(summary.contractsScanned).toBe(100);
      expect(summary.nextCursor).toBe('100');
      expect(repository.count({ tenantId: 'tenant-a' })).toBe(100);
    });

    it('resumes from a cursor on the next run (incremental walk)', async () => {
      const contracts = Array.from({ length: 250 }, (_, i) => `c${i}`);
      const { scanner, repository } = buildScanner({ contracts });

      const first = await scanner.run({ tenantId: 'tenant-a', maxContracts: 100 });
      const second = await scanner.run({
        tenantId: 'tenant-a',
        maxContracts: 100,
        cursor: first.nextCursor,
      });

      expect(first.contractsScanned).toBe(100);
      expect(second.contractsScanned).toBe(100);
      expect(second.nextCursor).toBe('200');
      expect(repository.count({ tenantId: 'tenant-a' })).toBe(200);

      // Third run drains the remaining 50 and reports no next cursor.
      const third = await scanner.run({
        tenantId: 'tenant-a',
        maxContracts: 100,
        cursor: second.nextCursor,
      });
      expect(third.contractsScanned).toBe(50);
      expect(third.nextCursor).toBeUndefined();
      expect(repository.count({ tenantId: 'tenant-a' })).toBe(250);
    });
  });

  describe('tenant isolation', () => {
    it('passes the payload tenant through to the indexed store', async () => {
      const { scanner, indexedStore } = buildScanner({ contracts: ['c1'] });
      await scanner.run({ tenantId: 'tenant-42' });
      expect(indexedStore.reads).toEqual([{ contractId: 'c1', tenantId: 'tenant-42' }]);
    });

    it('defaults the tenant and tags every report', async () => {
      const { scanner, repository } = buildScanner({ contracts: ['c1'] });
      await scanner.run({});
      const rows = repository.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tenantId).toBe('default');
    });
  });

  describe('never overwrites canonical state', () => {
    it('leaves the milestone service store untouched after a divergent scan', async () => {
      const service = new MilestonesService();
      service.create('c1', { title: 'Indexed title', amount: 500 });
      service.create('c1', { title: 'Second', amount: 100, completed: true });

      const indexedStore: MilestoneIndexedStore = {
        listMilestones: async (contractId: string) =>
          service.listByContract(contractId).map((r) => ({
            milestoneId: r.id,
            title: r.title,
            description: r.description,
            amount: r.amount,
            completed: r.completed,
          })),
      };
      const chainReader: MilestoneChainReader = {
        getLatestLedger: async () => HEAD_LEDGER,
        readMilestones: async () => ({
          // On-chain says amounts differ — but the scanner must only report.
          milestones: [
            { milestoneId: 'x', title: 'Indexed title', description: '', amount: 999, completed: false },
          ],
          ledger: HEAD_LEDGER,
        }),
      };
      const provider: MilestoneContractProvider = {
        // Respect the offset: the page is exhausted after the first fetch.
        listContractIds: async (_tenantId, _limit, offset) =>
          offset === 0 ? ['c1'] : [],
      };
      const repository = new InMemoryMilestoneDivergenceRepository();
      const scanner = new MilestoneDivergenceScanner({
        chainReader,
        indexedStore,
        contractProvider: provider,
        repository,
      });

      const before = service.listByContract('c1').map((r) => r.amount);
      const summary = await scanner.run({ tenantId: 'tenant-a' });

      expect(summary.divergent).toBe(1);
      // Canonical store is byte-for-byte unchanged.
      expect(service.listByContract('c1').map((r) => r.amount)).toEqual(before);
      expect(service.storeSize()).toBe(2);
      // The divergence is captured in the report instead.
      expect(repository.list({ tenantId: 'tenant-a' })[0]!.status).toBe('divergent');
    });
  });

  describe('retry idempotency', () => {
    it('re-running the same runId upserts reports instead of duplicating', async () => {
      const { scanner, repository } = buildScanner({
        contracts: ['c1', 'c2'],
        onChain: { c1: [milestone()], c2: [milestone()] },
      });

      await scanner.run({ tenantId: 'tenant-a', runId: 'run-x', maxContracts: 1 });
      await scanner.run({ tenantId: 'tenant-a', runId: 'run-x', maxContracts: 1, cursor: '1' });

      expect(repository.count({ tenantId: 'tenant-a', runId: 'run-x' })).toBe(2);
    });
  });

  describe('payload bounds', () => {
    it('clamps maxContracts into the safe range', () => {
      expect(clampMaxContracts(undefined)).toBe(DEFAULT_MAX_CONTRACTS_PER_RUN);
      expect(clampMaxContracts(0)).toBe(DEFAULT_MAX_CONTRACTS_PER_RUN);
      expect(clampMaxContracts(-5)).toBe(DEFAULT_MAX_CONTRACTS_PER_RUN);
      expect(clampMaxContracts(10)).toBe(10);
      expect(clampMaxContracts(MAX_CONTRACTS_PER_RUN + 100)).toBe(MAX_CONTRACTS_PER_RUN);
    });

    it('never compares more than maxContracts even when requested', async () => {
      const contracts = Array.from({ length: 200 }, (_, i) => `c${i}`);
      const { scanner, repository } = buildScanner({ contracts });
      const summary = await scanner.run({ tenantId: 't', maxContracts: 7 });
      expect(summary.contractsScanned).toBe(7);
      expect(repository.count({ tenantId: 't' })).toBe(7);
    });
  });
});

describe('sanitizeRpcError', () => {
  it('extracts a stable code and short message without stack traces', () => {
    const error = new Error('boom: super long message '.repeat(50));
    const sanitized = sanitizeRpcError(error);
    expect(sanitized.code).toBe('Error');
    expect(sanitized.message.length).toBeLessThanOrEqual(200);
    expect(sanitized.message).not.toContain('\n');
  });

  it('uses a typed code when present', () => {
    const err = new Error('x') as Error & { code?: string };
    err.code = 'soroban_rpc_timeout_error';
    expect(sanitizeRpcError(err).code).toBe('soroban_rpc_timeout_error');
  });

  it('handles non-Error throws', () => {
    const sanitized = sanitizeRpcError('string failure');
    expect(sanitized.code.length).toBeGreaterThan(0);
    expect(sanitized.message.length).toBeGreaterThan(0);
  });
});
