/**
 * Milestone divergence repository tests.
 *
 * Runs against a real in-memory SQLite database (migrations included) to
 * exercise the actual `milestone_divergence_reports` schema. Covers:
 *  - persist + read back
 *  - retry-safe upsert by (run_id, contract_id)
 *  - tenant isolation (query scoping)
 *  - bounded pagination (limit/offset clamping)
 *  - status filtering
 */

import Database from 'better-sqlite3';
import { closeDb, getDb } from '../../db/database';
import {
  SqliteMilestoneDivergenceRepository,
  toDivergenceReportRecord,
} from './repository';
import type { DivergenceReportRecord } from './types';

function makeReport(overrides: Partial<DivergenceReportRecord> = {}): DivergenceReportRecord {
  return toDivergenceReportRecord({
    runId: 'run-1',
    tenantId: 'tenant-a',
    contractId: 'contract-1',
    status: 'in_sync',
    blockHeight: 100,
    comparedAt: '2026-01-01T00:00:00.000Z',
    milestoneComparisons: [],
    differences: [],
    ...overrides,
  });
}

describe('SqliteMilestoneDivergenceRepository', () => {
  let db: Database.Database;
  let repo: SqliteMilestoneDivergenceRepository;

  beforeEach(() => {
    closeDb();
    db = getDb(':memory:');
    repo = new SqliteMilestoneDivergenceRepository(db);
  });

  afterEach(() => {
    closeDb();
  });

  it('persists and reads back a report', () => {
    const report = makeReport();
    repo.save(report);

    const rows = repo.list({ tenantId: 'tenant-a' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: 'run-1',
      tenantId: 'tenant-a',
      contractId: 'contract-1',
      status: 'in_sync',
      blockHeight: 100,
    });
  });

  it('upserts under (run_id, contract_id) so a retried run never duplicates', () => {
    const first = makeReport({ status: 'divergent' });
    repo.save(first);

    // Same run + contract, re-run after a retry → replaces the row.
    const second = makeReport({ status: 'in_sync', comparedAt: '2026-01-02T00:00:00.000Z' });
    repo.save(second);

    const rows = repo.list({ tenantId: 'tenant-a' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('in_sync');
    expect(rows[0]!.comparedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('keeps distinct contracts within a run as separate rows', () => {
    repo.save(makeReport({ contractId: 'c1' }));
    repo.save(makeReport({ contractId: 'c2' }));
    expect(repo.count({ runId: 'run-1' })).toBe(2);
  });

  it('scopes reads by tenant (tenant isolation)', () => {
    repo.save(makeReport({ tenantId: 'tenant-a', contractId: 'c1' }));
    repo.save(makeReport({ tenantId: 'tenant-b', contractId: 'c2' }));

    expect(repo.list({ tenantId: 'tenant-a' }).map((r) => r.contractId)).toEqual(['c1']);
    expect(repo.list({ tenantId: 'tenant-b' }).map((r) => r.contractId)).toEqual(['c2']);
    // Omitting the tenant filter still returns everything (admin listing), but
    // every row carries its tenant tag.
    expect(repo.list().map((r) => r.tenantId).sort()).toEqual(['tenant-a', 'tenant-b']);
  });

  it('filters by status', () => {
    repo.save(makeReport({ contractId: 'c1', status: 'in_sync' }));
    repo.save(makeReport({ contractId: 'c2', status: 'divergent' }));
    repo.save(makeReport({ contractId: 'c3', status: 'unavailable' }));

    expect(repo.list({ status: 'divergent' }).map((r) => r.contractId)).toEqual(['c2']);
    expect(repo.count({ status: 'unavailable' })).toBe(1);
  });

  it('clamps limit and honors offset (bounded pagination)', () => {
    for (let i = 0; i < 25; i += 1) {
      repo.save(makeReport({ contractId: `c${String(i).padStart(2, '0')}` }));
    }

    const page1 = repo.list({ tenantId: 'tenant-a', limit: 10, offset: 0 });
    expect(page1).toHaveLength(10);
    expect(page1[0]!.contractId).toBe('c00');

    const page3 = repo.list({ tenantId: 'tenant-a', limit: 10, offset: 20 });
    expect(page3).toHaveLength(5);
    expect(page3[0]!.contractId).toBe('c20');
  });

  it('clamps an oversized limit to the hard cap', () => {
    for (let i = 0; i < 30; i += 1) {
      repo.save(makeReport({ contractId: `c${i}` }));
    }
    const rows = repo.list({ tenantId: 'tenant-a', limit: 1_000_000 });
    expect(rows.length).toBeLessThanOrEqual(500);
  });

  it('round-trips differences and rpcError as structured JSON', () => {
    const report = makeReport({
      status: 'unavailable',
      rpcError: { code: 'soroban_rpc_timeout_error', message: 'RPC timed out' },
      differences: [
        { field: 'milestones.m1.amount', indexed: 1, onChain: 2 },
      ],
    });
    repo.save(report);

    const [row] = repo.list({ tenantId: 'tenant-a' });
    expect(row!.rpcError).toEqual({
      code: 'soroban_rpc_timeout_error',
      message: 'RPC timed out',
    });
    expect(row!.differences).toEqual([
      { field: 'milestones.m1.amount', indexed: 1, onChain: 2 },
    ]);
  });
});
