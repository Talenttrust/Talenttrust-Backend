/**
 * @module milestones/divergence/repository
 * @description Persistence for milestone divergence reports.
 *
 * The repository is the **only** writer in the divergence feature. It writes
 * audit rows about comparisons; it never touches milestone or contract rows,
 * so canonical state cannot be overwritten through this feature by accident.
 *
 * Guarantees:
 *  - **Tenant isolation**: every row carries `tenant_id` and every query
 *    scopes by it. Omitting a tenant in a query yields no rows for
 *    tenant-tagged data (the scanner always tags).
 *  - **Retry-safe**: `UNIQUE(run_id, contract_id)` makes re-running a scan
 *    under the same run id an upsert, so a retried job never duplicates
 *    reports.
 *  - **Bounded**: list queries apply a clamped `limit` + `offset`.
 *  - All writes use prepared statements with bound parameters.
 */

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type {
  ContractComparisonStatus,
  DivergenceReportQuery,
  DivergenceReportRecord,
  MilestoneComparison,
  MilestoneFieldDifference,
} from './types';

/** Default page size when a query omits `limit`. */
export const DEFAULT_DIVERGENCE_REPORT_LIMIT = 50;

/** Hard cap on any single list query. */
export const MAX_DIVERGENCE_REPORT_LIMIT = 500;

interface ReportRow {
  id: string;
  run_id: string;
  tenant_id: string;
  contract_id: string;
  status: string;
  block_height: number | null;
  compared_at: string;
  milestone_comparisons: string;
  differences: string;
  rpc_error: string | null;
  created_at: string;
}

function toRecord(row: ReportRow): DivergenceReportRecord {
  return {
    id: row.id,
    runId: row.run_id,
    tenantId: row.tenant_id,
    contractId: row.contract_id,
    status: row.status as ContractComparisonStatus,
    ...(row.block_height !== null && { blockHeight: row.block_height }),
    comparedAt: row.compared_at,
    milestoneComparisons: JSON.parse(
      row.milestone_comparisons,
    ) as MilestoneComparison[],
    differences: JSON.parse(row.differences) as MilestoneFieldDifference[],
    ...(row.rpc_error !== null && { rpcError: JSON.parse(row.rpc_error) }),
    createdAt: row.created_at,
  };
}

export interface MilestoneDivergenceRepository {
  save(report: DivergenceReportRecord): void;
  list(query?: DivergenceReportQuery): DivergenceReportRecord[];
  count(query?: DivergenceReportQuery): number;
}

/**
 * SQLite-backed implementation. Instantiate with the shared database
 * (see `src/db/database.ts`) or an in-memory instance in tests.
 */
export class SqliteMilestoneDivergenceRepository
  implements MilestoneDivergenceRepository
{
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Upsert a report row keyed by `(run_id, contract_id)`. */
  save(report: DivergenceReportRecord): void {
    this.db
      .prepare<
        [
          string,
          string,
          string,
          string,
          string,
          number | null,
          string,
          string,
          string,
          string | null,
          string,
        ]
      >(
        `INSERT INTO milestone_divergence_reports
           (id, run_id, tenant_id, contract_id, status, block_height,
            compared_at, milestone_comparisons, differences, rpc_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, contract_id) DO UPDATE SET
           status               = excluded.status,
           block_height         = excluded.block_height,
           compared_at          = excluded.compared_at,
           milestone_comparisons = excluded.milestone_comparisons,
           differences          = excluded.differences,
           rpc_error            = excluded.rpc_error`,
      )
      .run(
        report.id,
        report.runId,
        report.tenantId,
        report.contractId,
        report.status,
        report.blockHeight ?? null,
        report.comparedAt,
        JSON.stringify(report.milestoneComparisons),
        JSON.stringify(report.differences),
        report.rpcError ? JSON.stringify(report.rpcError) : null,
        report.createdAt,
      );
  }

  list(query: DivergenceReportQuery = {}): DivergenceReportRecord[] {
    const { where, params } = this.buildWhere(query);
    const limit = clampLimit(query.limit);
    const offset = Math.max(Math.floor(query.offset ?? 0), 0);

    const rows = this.db
      .prepare<unknown[], ReportRow>(
        `SELECT * FROM milestone_divergence_reports
         ${where}
         ORDER BY compared_at DESC, contract_id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    return rows.map(toRecord);
  }

  count(query: DivergenceReportQuery = {}): number {
    const { where, params } = this.buildWhere(query);
    const row = this.db
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) AS n FROM milestone_divergence_reports ${where}`,
      )
      .get(...params);
    return row?.n ?? 0;
  }

  private buildWhere(query: DivergenceReportQuery): {
    where: string;
    params: unknown[];
  } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (query.runId !== undefined) {
      clauses.push('run_id = ?');
      params.push(query.runId);
    }
    if (query.tenantId !== undefined) {
      clauses.push('tenant_id = ?');
      params.push(query.tenantId);
    }
    if (query.status !== undefined) {
      clauses.push('status = ?');
      params.push(query.status);
    }

    return {
      where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  }
}

/**
 * In-memory implementation for deterministic tests and local development.
 * Mirrors the SQLite semantics (upsert by run+contract, tenant-scoped list).
 */
export class InMemoryMilestoneDivergenceRepository
  implements MilestoneDivergenceRepository
{
  private readonly rows = new Map<string, DivergenceReportRecord>();

  save(report: DivergenceReportRecord): void {
    // Same upsert semantics as the SQLite UNIQUE(run_id, contract_id).
    const key = `${report.runId}\u0000${report.contractId}`;
    this.rows.set(key, { ...report });
  }

  list(query: DivergenceReportQuery = {}): DivergenceReportRecord[] {
    const limit = clampLimit(query.limit);
    const offset = Math.max(Math.floor(query.offset ?? 0), 0);

    const matched = Array.from(this.rows.values())
      .filter((r) => matches(r, query))
      .sort((a, b) => {
        const byComparedAt = b.comparedAt.localeCompare(a.comparedAt);
        if (byComparedAt !== 0) return byComparedAt;
        return a.contractId.localeCompare(b.contractId);
      });

    return matched.slice(offset, offset + limit).map((r) => ({ ...r }));
  }

  count(query: DivergenceReportQuery = {}): number {
    return Array.from(this.rows.values()).filter((r) => matches(r, query))
      .length;
  }

  clear(): void {
    this.rows.clear();
  }
}

function matches(r: DivergenceReportRecord, query: DivergenceReportQuery): boolean {
  if (query.runId !== undefined && r.runId !== query.runId) return false;
  if (query.tenantId !== undefined && r.tenantId !== query.tenantId) return false;
  if (query.status !== undefined && r.status !== query.status) return false;
  return true;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_DIVERGENCE_REPORT_LIMIT;
  const floored = Math.floor(limit);
  if (!Number.isFinite(floored) || floored < 1) return DEFAULT_DIVERGENCE_REPORT_LIMIT;
  return Math.min(floored, MAX_DIVERGENCE_REPORT_LIMIT);
}

/** Builds a complete, persistable report row from a comparison. */
export function toDivergenceReportRecord(
  input: {
    runId: string;
    tenantId: string;
    contractId: string;
    status: ContractComparisonStatus;
    blockHeight?: number;
    comparedAt: string;
    milestoneComparisons: MilestoneComparison[];
    differences: MilestoneFieldDifference[];
    rpcError?: { code: string; message: string };
    id?: string;
    createdAt?: string;
  },
): DivergenceReportRecord {
  return {
    id: input.id ?? randomUUID(),
    runId: input.runId,
    tenantId: input.tenantId,
    contractId: input.contractId,
    status: input.status,
    ...(input.blockHeight !== undefined && { blockHeight: input.blockHeight }),
    comparedAt: input.comparedAt,
    milestoneComparisons: input.milestoneComparisons,
    differences: input.differences,
    ...(input.rpcError !== undefined && { rpcError: input.rpcError }),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
