/**
 * @module milestones/divergence/scanner
 * @description Bounded comparison job: indexed milestone state vs on-chain
 *              milestone state.
 *
 * The scanner enforces the issue's core invariants:
 *
 *  - **Bounded**: one run compares at most `maxContracts` contracts, walking
 *    the provider with an offset cursor. A huge contract set is processed
 *    across many runs, never loaded at once.
 *  - **Report-only**: the scanner's only writes are divergence report rows
 *    (auditability). It never calls milestone/contract write paths, so
 *    canonical state is never silently overwritten.
 *  - **Failure isolation**: a per-contract RPC failure becomes an
 *    `unavailable` report and the run continues. A head-ledger failure aborts
 *    the run so the queue retries it (a retried run is idempotent because
 *    reports upsert under `runId`).
 *  - **Tenant isolation**: `tenantId` flows from payload → readers →
 *    reports, and the report repository always scopes by tenant.
 *
 * Retry/ordering semantics: contracts are processed sequentially in the
 * provider's stable order (id ASC). Report writes are transactional per
 * contract. If the process dies mid-run, the next run starts a fresh
 * `runId` (or reuses the caller's) and simply upserts — comparisons are
 * idempotent reads.
 */

import { createLogger } from '../../logger';
import {
  compareContract,
} from './compare';
import {
  toDivergenceReportRecord,
  type MilestoneDivergenceRepository,
} from './repository';
import type { MilestoneChainReader } from './chain-reader';
import type {
  MilestoneContractProvider,
  MilestoneIndexedStore,
} from './indexed-reader';
import type {
  ContractComparison,
  ContractComparisonStatus,
  DivergenceReportRecord,
  MilestoneDivergenceScanPayload,
  DivergenceScanSummary,
} from './types';

/** Default upper bound on contracts compared per run. */
export const DEFAULT_MAX_CONTRACTS_PER_RUN = 100;

/** Hard cap — a payload can never request more than this. */
export const MAX_CONTRACTS_PER_RUN = 500;

/** Sanitized error message length cap (no stack traces, no secrets). */
export const MAX_RPC_ERROR_MESSAGE_LENGTH = 200;

export interface MilestoneDivergenceScannerOptions {
  chainReader: MilestoneChainReader;
  indexedStore: MilestoneIndexedStore;
  contractProvider: MilestoneContractProvider;
  repository: MilestoneDivergenceRepository;
}

export interface RunMilestoneDivergenceScanInput {
  tenantId?: string;
  maxContracts?: number;
  cursor?: string;
  runId?: string;
  correlationId?: string;
  requestId?: string;
}

/** Clamp a payload's maxContracts into the safe bounded range. */
export function clampMaxContracts(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CONTRACTS_PER_RUN;
  const floored = Math.floor(value);
  if (!Number.isFinite(floored) || floored < 1) {
    return DEFAULT_MAX_CONTRACTS_PER_RUN;
  }
  return Math.min(floored, MAX_CONTRACTS_PER_RUN);
}

export class MilestoneDivergenceScanner {
  private readonly chainReader: MilestoneChainReader;
  private readonly indexedStore: MilestoneIndexedStore;
  private readonly contractProvider: MilestoneContractProvider;
  private readonly repository: MilestoneDivergenceRepository;

  constructor(options: MilestoneDivergenceScannerOptions) {
    this.chainReader = options.chainReader;
    this.indexedStore = options.indexedStore;
    this.contractProvider = options.contractProvider;
    this.repository = options.repository;
  }

  /**
   * Runs one bounded comparison pass.
   *
   * @throws When the chain head cannot be determined — the whole run is
   *         meaningless without a block height, so the caller (queue) retries.
   */
  async run(input: RunMilestoneDivergenceScanInput = {}): Promise<DivergenceScanSummary> {
    const log = createLogger({
      processor: 'milestone-divergence-scan',
      ...(input.correlationId && { correlationId: input.correlationId }),
      ...(input.requestId && { requestId: input.requestId }),
    });

    const tenantId = input.tenantId ?? 'default';
    const maxContracts = clampMaxContracts(input.maxContracts);
    const runId = input.runId ?? `milestone-divergence-${Date.now()}`;

    log.info('Milestone divergence scan starting', {
      runId,
      tenantId,
      maxContracts,
      cursor: input.cursor ?? null,
    });

    // The block height anchors every comparison. Without a head ledger we
    // cannot stamp reports, so fail the run (the queue retries with backoff).
    const blockHeight = await this.chainReader.getLatestLedger();

    const cursorOffset = cursorToOffset(input.cursor);

    let contractsScanned = 0;
    let inSync = 0;
    let divergent = 0;
    let unavailable = 0;
    let lastContractId: string | undefined;

    // Walk the provider in bounded pages until maxContracts is reached.
    // A page may return fewer than `remaining`, which naturally ends the loop
    // when the set is exhausted.
    const remaining = () => maxContracts - contractsScanned;
    while (contractsScanned < maxContracts) {
      const page = await this.contractProvider.listContractIds(
        tenantId,
        Math.min(remaining(), 100),
        cursorOffset + contractsScanned,
      );
      if (page.length === 0) break;

      for (const contractId of page) {
        if (contractsScanned >= maxContracts) break;
        lastContractId = contractId;

        const comparison = await this.compareContract(
          contractId,
          tenantId,
          blockHeight,
          runId,
          log,
        );
        if (comparison.status === 'in_sync') inSync += 1;
        else if (comparison.status === 'divergent') divergent += 1;
        else unavailable += 1;
        contractsScanned += 1;
      }
    }

    const summary: DivergenceScanSummary = {
      runId,
      tenantId,
      blockHeight,
      contractsScanned,
      inSync,
      divergent,
      unavailable,
      ...(contractsScanned === maxContracts && lastContractId !== undefined
        ? { nextCursor: offsetToCursor(cursorOffset + contractsScanned) }
        : {}),
    };

    log.info('Milestone divergence scan completed', summary);
    return summary;
  }

  /**
   * Compares one contract and persists its report. Per-contract RPC failures
   * are captured as `unavailable` reports and never thrown.
   */
  private async compareContract(
    contractId: string,
    tenantId: string,
    blockHeight: number,
    runId: string,
    log: ReturnType<typeof createLogger>,
  ): Promise<ContractComparison> {
    const comparedAt = new Date().toISOString();

    try {
      const indexed = await this.indexedStore.listMilestones(contractId, tenantId);
      const onChain = await this.chainReader.readMilestones(contractId);

      const comparison = compareContract(indexed, onChain.milestones, {
        contractId,
        tenantId,
        blockHeight: onChain.ledger,
        comparedAt,
      });

      this.persistReport(
        {
          runId,
          tenantId,
          contractId,
          status: comparison.status,
          blockHeight: comparison.blockHeight,
          comparedAt: comparison.comparedAt,
          milestoneComparisons: comparison.milestoneComparisons,
          differences: comparison.differences,
        },
        log,
      );

      if (comparison.status === 'divergent') {
        log.warn('Milestone divergence detected', {
          contractId,
          tenantId,
          runId,
          blockHeight: comparison.blockHeight,
          divergentMilestones: comparison.milestoneComparisons.filter(
            (m) => m.status !== 'in_sync',
          ).length,
          fieldDifferences: comparison.differences.length,
          missingIndexedMilestones: comparison.missingIndexedMilestones,
        });
      }

      return comparison;
    } catch (error) {
      // Per-contract RPC failure: record it and continue the run. The error
      // is sanitized before persisting/logging (code + short message only).
      const rpcError = sanitizeRpcError(error);
      log.warn('Milestone divergence scan: RPC unavailable for contract', {
        contractId,
        tenantId,
        runId,
        error: rpcError,
      });

      this.persistReport(
        {
          runId,
          tenantId,
          contractId,
          status: 'unavailable',
          comparedAt,
          milestoneComparisons: [],
          differences: [],
          rpcError,
        },
        log,
      );

      return {
        contractId,
        tenantId,
        status: 'unavailable',
        comparedAt,
        milestoneComparisons: [],
        missingIndexedMilestones: [],
        differences: [],
        rpcError,
      };
    }
  }

  private persistReport(
    input: {
      runId: string;
      tenantId: string;
      contractId: string;
      status: ContractComparisonStatus;
      blockHeight?: number;
      comparedAt: string;
      milestoneComparisons: ContractComparison['milestoneComparisons'];
      differences: ContractComparison['differences'];
      rpcError?: { code: string; message: string };
    },
    log: ReturnType<typeof createLogger>,
  ): void {
    const report: DivergenceReportRecord = toDivergenceReportRecord(input);
    this.repository.save(report);
    log.info('Milestone divergence report persisted', {
      runId: report.runId,
      contractId: report.contractId,
      tenantId: report.tenantId,
      status: report.status,
      blockHeight: report.blockHeight ?? null,
    });
  }
}

/** Parses a cursor into an offset (cursors are opaque offsets for now). */
function cursorToOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number(cursor);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function offsetToCursor(offset: number): string {
  return String(offset);
}

/**
 * Reduces an arbitrary thrown value into a safe `{ code, message }` pair.
 * Never includes stack traces, provider secrets, or internal paths.
 */
export function sanitizeRpcError(error: unknown): { code: string; message: string } {
  const err = error instanceof Error ? error : new Error(String(error));
  const candidateCode =
    typeof (error as { code?: unknown })?.code === 'string'
      ? String((error as { code?: unknown }).code)
      : err.name;

  const safeCode = candidateCode.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 64);
  const rawMessage = err.message
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, MAX_RPC_ERROR_MESSAGE_LENGTH);

  return {
    code: safeCode.length > 0 ? safeCode : 'rpc_error',
    message: rawMessage.length > 0 ? rawMessage : 'RPC call failed',
  };
}
