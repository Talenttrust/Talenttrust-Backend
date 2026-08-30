/**
 * @module milestones/divergence/indexed-reader
 * @description Reads the backend's *indexed* milestone view (the projection)
 *              and the set of contracts to compare.
 *
 * The indexed view is the source of truth for what the backend *thinks* the
 * chain says. Comparing it against the chain reader surfaces drift caused by
 * missed events, reorgs, or partial ingestion.
 *
 * Tenant isolation: both interfaces accept a `tenantId`. The built-in
 * MilestonesService-backed store and the SQLite contract provider do not yet
 * carry tenant columns (the contracts/milestones tables predate multi-tenancy),
 * so the built-ins treat `tenantId` as a metadata scoping hint. Deployments
 * with tenant-tagged tables MUST inject implementations that filter on it —
 * the scanner passes the payload's `tenantId` through untouched, and the
 * report repository always isolates by tenant regardless of the reader.
 */

import type { MilestoneState } from './types';
import { MilestonesService, type MilestoneRecord } from '../../services/milestones.service';

/** Read access to the indexed milestone view for a contract. */
export interface MilestoneIndexedStore {
  listMilestones(
    contractId: string,
    tenantId?: string,
  ): Promise<MilestoneState[]>;
}

/** Enumerates the bounded set of contracts a scan should compare. */
export interface MilestoneContractProvider {
  /**
   * @param tenantId - Tenant scope hint (see module docs).
   * @param limit    - Max ids to return (hard-capped by implementations).
   * @param offset   - Pagination offset (contracts ordered by id).
   */
  listContractIds(
    tenantId?: string,
    limit?: number,
    offset?: number,
  ): Promise<string[]>;
}

/**
 * Indexed store backed by the existing in-memory `MilestonesService`.
 *
 * Soft-deleted milestones are excluded (they are not part of the live
 * projection), matching how public reads treat them.
 */
export class MilestonesServiceIndexedStore implements MilestoneIndexedStore {
  private readonly service: MilestonesService;

  constructor(service: MilestonesService = new MilestonesService()) {
    this.service = service;
  }

  async listMilestones(
    contractId: string,
    _tenantId?: string,
  ): Promise<MilestoneState[]> {
    const records = this.service.listByContract(contractId);
    return records.map(toMilestoneState);
  }
}

/**
 * Default contract provider reading contract ids from the SQLite `contracts`
 * table (active rows only), ordered by id for stable pagination.
 */
export class SqliteMilestoneContractProvider implements MilestoneContractProvider {
  private readonly db: import('better-sqlite3').Database;

  constructor(db: import('better-sqlite3').Database) {
    this.db = db;
  }

  async listContractIds(
    _tenantId?: string,
    limit = 100,
    offset = 0,
  ): Promise<string[]> {
    const clampedLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
    const clampedOffset = Math.max(Math.floor(offset), 0);
    const rows = this.db
      .prepare<[number, number], { id: string }>(
        `SELECT id FROM contracts
         WHERE deleted_at IS NULL
         ORDER BY id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(clampedLimit, clampedOffset);
    return rows.map((r) => r.id);
  }
}

/** Maps a persisted milestone record to the normalized comparison shape. */
export function toMilestoneState(record: MilestoneRecord): MilestoneState {
  return {
    milestoneId: record.id,
    title: record.title,
    description: record.description,
    amount: record.amount,
    ...(record.deadline !== undefined && { deadline: record.deadline }),
    completed: record.completed,
  };
}
