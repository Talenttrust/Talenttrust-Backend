/**
 * Raw event retention repository tests.
 *
 * Runs against a real in-memory SQLite database (migrations included) to
 * exercise the actual schema from migration v16. Covers:
 *  - candidate selection with per-network cutoffs (mixed networks)
 *  - transactional archive + purge (archive row is never lost)
 *  - idempotent archival (already-archived events are not duplicated)
 *  - legal hold CRUD (active/expired)
 *  - migration backfill of `ingested_at` for legacy rows
 */

import Database from 'better-sqlite3';
import { closeDb, getDb } from '../db/database';
import {
  SqliteRawEventRetentionRepository,
  type RawEventRecord,
  type RawEventCandidateQuery,
} from './rawEventRetention.repository';

function makeRecord(overrides: Partial<RawEventRecord> = {}): RawEventRecord {
  return {
    eventId: 'evt-1',
    contractId: 'contract-1',
    eventType: 'escrow:created',
    payload: '{"amount":500}',
    timestamp: '2026-05-01T00:00:00.000Z',
    network: 'soroban',
    ingestedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function query(cutoffIso: string, limit = 100): RawEventCandidateQuery {
  return {
    cutoffByNetwork: { soroban: cutoffIso, stellar: cutoffIso, offchain: cutoffIso },
    limit,
  };
}

/** Inserts a row exactly as the EventIndexerService would (legacy shape). */
function insertLegacyRow(
  db: Database.Database,
  row: { eventId: string; contractId: string; eventType: string; payload: string; timestamp: string },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO smart_contract_events
       (eventId, contractId, eventType, payload, timestamp)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.eventId, row.contractId, row.eventType, row.payload, row.timestamp);
}

describe('SqliteRawEventRetentionRepository', () => {
  let db: Database.Database;
  let repo: SqliteRawEventRetentionRepository;

  beforeEach(() => {
    closeDb();
    db = getDb(':memory:');
    repo = new SqliteRawEventRetentionRepository(db);
  });

  afterEach(() => {
    closeDb();
  });

  it('selects only candidates past their per-network cutoff', () => {
    const now = '2026-06-01T00:00:00.000Z';
    const thirtyDaysAgo = '2026-05-02T00:00:00.000Z';

    // Uses the raw INSERT path so network defaults to NULL → offchain.
    insertLegacyRow(db, {
      eventId: 'legacy-old',
      contractId: 'c1',
      eventType: 'escrow:created',
      payload: '{}',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    const candidates = repo.listCandidates(query(thirtyDaysAgo));
    expect(candidates.map((c) => c.eventId)).toEqual(['legacy-old']);
    // Legacy rows without a network default to `offchain`.
    expect(candidates[0]!.network).toBe('offchain');
    // ingested_at was backfilled from timestamp by the migration.
    expect(candidates[0]!.ingestedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(now > candidates[0]!.ingestedAt).toBe(true);
  });

  it('archives and purges atomically', () => {
    const record = makeRecord({ eventId: 'evt-1' });
    insertLegacyRow(db, {
      eventId: record.eventId,
      contractId: record.contractId,
      eventType: record.eventType,
      payload: record.payload,
      timestamp: record.timestamp,
    });

    const outcome = repo.archiveAndPurge(record, '2026-06-01T00:00:00.000Z', true);

    expect(outcome).toEqual({ archived: true, purged: true });
    expect(repo.isArchived('evt-1')).toBe(true);
    expect(repo.findRawEvent('evt-1')).toBeUndefined();
  });

  it('re-archiving an already-archived event is a no-op (idempotent)', () => {
    const record = makeRecord({ eventId: 'evt-1' });
    insertLegacyRow(db, {
      eventId: record.eventId,
      contractId: record.contractId,
      eventType: record.eventType,
      payload: record.payload,
      timestamp: record.timestamp,
    });

    const first = repo.archiveAndPurge(record, '2026-06-01T00:00:00.000Z', false);
    expect(first.archived).toBe(true);

    const second = repo.archiveAndPurge(record, '2026-06-02T00:00:00.000Z', false);
    expect(second).toEqual({ archived: false, purged: false });

    const count = db
      .prepare<[string], { n: number }>(
        'SELECT COUNT(*) AS n FROM raw_event_archive WHERE event_id = ?',
      )
      .get('evt-1');
    expect(count!.n).toBe(1);
  });

  it('does not purge when the archive is skipped (purge=false)', () => {
    const record = makeRecord({ eventId: 'evt-1' });
    insertLegacyRow(db, {
      eventId: record.eventId,
      contractId: record.contractId,
      eventType: record.eventType,
      payload: record.payload,
      timestamp: record.timestamp,
    });

    const outcome = repo.archiveAndPurge(record, '2026-06-01T00:00:00.000Z', false);
    expect(outcome).toEqual({ archived: true, purged: false });
    expect(repo.findRawEvent('evt-1')).toBeDefined();
  });

  it('manages legal holds (add, active list, release, expiry)', () => {
    const hold = repo.addHold({
      scopeType: 'contract',
      scopeValue: 'c-1',
      reason: 'dispute',
      actor: 'compliance',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(hold.id).toBeDefined();

    const active = repo.listActiveHolds('2026-06-01T00:00:00.000Z');
    expect(active).toHaveLength(1);
    expect(active[0]!.scopeValue).toBe('c-1');

    // Expired holds are not active.
    repo.addHold({
      scopeType: 'network',
      scopeValue: 'stellar',
      reason: 'old',
      actor: 'compliance',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
    });
    expect(repo.listActiveHolds('2026-06-01T00:00:00.000Z')).toHaveLength(1);

    expect(repo.releaseHold(hold.id)).toBe(true);
    expect(repo.listActiveHolds('2026-06-01T00:00:00.000Z')).toHaveLength(0);
  });

  it('counts candidates with the same per-network semantics', () => {
    insertLegacyRow(db, {
      eventId: 'a',
      contractId: 'c1',
      eventType: 'escrow:created',
      payload: '{}',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    insertLegacyRow(db, {
      eventId: 'b',
      contractId: 'c2',
      eventType: 'escrow:completed',
      payload: '{}',
      timestamp: '2026-05-15T00:00:00.000Z',
    });

    expect(repo.countCandidates(query('2026-05-02T00:00:00.000Z'))).toBe(1);
    expect(repo.countCandidates(query('2026-06-01T00:00:00.000Z'))).toBe(2);
  });
});
