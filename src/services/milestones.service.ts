import { randomUUID } from 'crypto';
import { Milestone, validateContractBounds, ContractBoundsError } from '../contracts/bounds';
import {
  SoftDeleteRetentionError,
  filterNotDeleted,
  isPastRetentionWindow,
  isSoftDeleted,
  isWithinRetentionWindow,
  parseRetentionDays,
} from '../utils/softDelete';

/** Env key for milestones soft-delete retention window (days). */
export const MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV =
  'MILESTONES_SOFT_DELETE_RETENTION_DAYS';

/**
 * Persisted milestone record with soft-delete metadata.
 * Soft-deleted milestones keep `deletedAt` set and are excluded from default reads.
 */
export interface MilestoneRecord {
  id: string;
  contractId: string;
  title: string;
  description: string;
  amount: number;
  deadline?: string;
  completed: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** ISO timestamp when soft-deleted; undefined/null while active. */
  deletedAt?: Date | null;
}

export interface CreateMilestoneInput {
  title: string;
  description?: string;
  amount: number;
  deadline?: string;
  completed?: boolean;
}

export class MilestoneNotFoundError extends Error {
  public readonly code = 'milestone_not_found';
  public readonly statusCode = 404;

  constructor(message: string) {
    super(message);
    this.name = 'MilestoneNotFoundError';
  }
}

export class MilestoneConflictError extends Error {
  public readonly code = 'milestone_conflict';
  public readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'MilestoneConflictError';
  }
}

/** In-memory store for milestones (demo persistence; production would use SQLite). */
const milestoneStore = new Map<string, MilestoneRecord>();

/**
 * Service layer for milestone business logic, including soft-delete / restore / purge.
 */
export class MilestonesService {
  /**
   * Retention window in days. Overridable via env for tests and ops.
   */
  public getRetentionDays(): number {
    return parseRetentionDays(process.env[MILESTONES_SOFT_DELETE_RETENTION_DAYS_ENV]);
  }

  /**
   * Validates milestones against policy bounds only.
   * Throws ContractBoundsError if validation fails.
   */
  public validateBounds(budget: number, milestones?: Milestone[]): void {
    const boundsCheck = validateContractBounds(budget, milestones);
    if (!boundsCheck.valid) {
      throw new ContractBoundsError(boundsCheck.error);
    }
  }

  /**
   * Validates milestones against policy bounds and the contract's budget.
   * Throws ContractBoundsError if validation fails.
   *
   * @param budget The total contract budget in stroops.
   * @param milestones Optional list of milestones to validate.
   */
  public validateMilestonesAgainstBudget(budget: number, milestones?: Milestone[]): void {
    this.validateBounds(budget, milestones);

    // Enforce that the sum of milestone amounts does not exceed the contract
    // budget. `validateContractBounds` only guards the absolute policy cap
    // (MAX_CONTRACT_AMOUNT_STROOPS); the per-contract budget is the tighter,
    // caller-supplied limit that milestone payouts must never overrun.
    if (milestones && milestones.length > 0) {
      const totalMilestoneAmount = milestones.reduce(
        (sum, milestone) => sum + milestone.amount,
        0,
      );
      if (totalMilestoneAmount > budget) {
        throw new ContractBoundsError(
          `Total milestone amount exceeds maximum contract amount ` +
            `(milestones total ${totalMilestoneAmount} exceeds budget of ${budget})`,
        );
      }
    }
  }

  /**
   * Create a milestone for a contract. New milestones are active (not deleted).
   */
  public create(contractId: string, input: CreateMilestoneInput): MilestoneRecord {
    const now = new Date();
    const record: MilestoneRecord = {
      id: randomUUID(),
      contractId,
      title: input.title,
      description: input.description ?? '',
      amount: input.amount,
      deadline: input.deadline,
      completed: input.completed ?? false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    milestoneStore.set(record.id, record);
    return { ...record };
  }

  /**
   * List milestones for a contract. Soft-deleted rows are excluded unless
   * `includeDeleted` is true.
   */
  public listByContract(
    contractId: string,
    options: { includeDeleted?: boolean } = {},
  ): MilestoneRecord[] {
    const all = Array.from(milestoneStore.values()).filter(
      (m) => m.contractId === contractId,
    );
    const filtered = options.includeDeleted ? all : filterNotDeleted(all);
    return filtered
      .map((m) => ({ ...m }))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /**
   * Fetch a single milestone. Soft-deleted milestones are hidden by default
   * (404) unless `includeDeleted` is true.
   */
  public getById(
    contractId: string,
    milestoneId: string,
    options: { includeDeleted?: boolean } = {},
  ): MilestoneRecord {
    const record = milestoneStore.get(milestoneId);
    if (!record || record.contractId !== contractId) {
      throw new MilestoneNotFoundError(
        `Milestone ${milestoneId} not found for contract ${contractId}`,
      );
    }
    if (!options.includeDeleted && isSoftDeleted(record.deletedAt)) {
      throw new MilestoneNotFoundError(
        `Milestone ${milestoneId} not found for contract ${contractId}`,
      );
    }
    return { ...record };
  }

  /**
   * Soft-delete a milestone: set `deletedAt` without purging the record.
   * Already-deleted milestones return 409.
   */
  public softDelete(contractId: string, milestoneId: string, now: Date = new Date()): MilestoneRecord {
    const record = milestoneStore.get(milestoneId);
    if (!record || record.contractId !== contractId) {
      throw new MilestoneNotFoundError(
        `Milestone ${milestoneId} not found for contract ${contractId}`,
      );
    }
    if (isSoftDeleted(record.deletedAt)) {
      throw new MilestoneConflictError(`Milestone ${milestoneId} is already soft-deleted`);
    }

    const updated: MilestoneRecord = {
      ...record,
      deletedAt: now,
      updatedAt: now,
    };
    milestoneStore.set(milestoneId, updated);
    return { ...updated };
  }

  /**
   * Restore a soft-deleted milestone while still inside the retention window.
   * Past the window → SoftDeleteRetentionError (410).
   * Active (not deleted) → 409.
   */
  public restore(
    contractId: string,
    milestoneId: string,
    now: Date = new Date(),
  ): MilestoneRecord {
    const record = milestoneStore.get(milestoneId);
    if (!record || record.contractId !== contractId) {
      throw new MilestoneNotFoundError(
        `Milestone ${milestoneId} not found for contract ${contractId}`,
      );
    }
    if (!isSoftDeleted(record.deletedAt) || !record.deletedAt) {
      throw new MilestoneConflictError(`Milestone ${milestoneId} is not soft-deleted`);
    }

    const retentionDays = this.getRetentionDays();
    if (!isWithinRetentionWindow(record.deletedAt, retentionDays, now)) {
      throw new SoftDeleteRetentionError(
        `Milestone ${milestoneId} retention window of ${retentionDays} days has expired`,
      );
    }

    const updated: MilestoneRecord = {
      ...record,
      deletedAt: null,
      updatedAt: now,
    };
    milestoneStore.set(milestoneId, updated);
    return { ...updated };
  }

  /**
   * Hard-delete (purge) soft-deleted milestones whose retention window has elapsed.
   * Returns the number of records purged.
   */
  public purgeExpired(now: Date = new Date()): number {
    const retentionDays = this.getRetentionDays();
    let purged = 0;
    for (const [id, record] of milestoneStore.entries()) {
      if (
        isSoftDeleted(record.deletedAt) &&
        record.deletedAt &&
        isPastRetentionWindow(record.deletedAt, retentionDays, now)
      ) {
        milestoneStore.delete(id);
        purged += 1;
      }
    }
    return purged;
  }

  /** Test helper: clear the in-memory store. */
  public clearStore(): void {
    milestoneStore.clear();
  }

  /** Test helper: current store size (including soft-deleted). */
  public storeSize(): number {
    return milestoneStore.size;
  }
}

export const milestonesService = new MilestonesService();
