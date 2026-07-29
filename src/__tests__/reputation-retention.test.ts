/**
 * Reputation Data Retention — documented-invariant tests
 *
 * Issue #990: `docs/reputation-retention.md` states what the reputation
 * subsystem stores and for how long. Documentation drifts silently; these tests
 * pin the specific claims that the doc makes, so a change to a retention window
 * or to the durable schema fails here instead of quietly making the doc wrong.
 *
 * Each block maps to a section of the doc:
 *   §1.1 / §2.1  durable `reputation_entries` schema, append-only, no TTL
 *   §1.5 / §2.3  read-cache TTL, capacity, expiry and write invalidation
 *   §1.6 / §2.3  idempotency-record TTL and sweep
 *   §2.5         reputation is outside the automated retention engine
 *   §3           comment plaintext never reaches the audit store
 *
 * No new production behaviour is introduced by this suite — it asserts the
 * behaviour that already exists and is now documented.
 */

import { createHash } from 'crypto';

import Database from '../db/betterSqlite3';
import { runMigrations } from '../db/migrations';
import { ReputationRepository } from '../repositories/reputationRepository';
import { ReputationService } from '../services/reputation.service';
import { auditService } from '../audit/service';
import { auditStore } from '../audit/store';
import {
  ReputationLruCache,
  DEFAULT_REPUTATION_CACHE_TTL_MS,
  DEFAULT_REPUTATION_CACHE_MAX_ENTRIES,
} from '../utils/reputationCache';
import { reputationIdempotencyStore } from '../middleware/reputationIdempotency';
import { DataEntityType } from '../retention/types';

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Opens an in-memory database with the real migration set applied.
 *
 * The `api_keys` shim mirrors `SqliteStore.initSchema()`
 * (`src/database/sqliteStore.ts`), which bootstraps that table at runtime.
 * Migration 14 (`add_call_count_to_api_keys`) assumes it already exists, so a
 * database built from migrations alone cannot reach the latest version without
 * it. The column it adds is deliberately omitted here so the migration still
 * runs for real.
 */
function createMigratedDb(): ReturnType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      key_hash     TEXT NOT NULL,
      scope        TEXT NOT NULL,
      created_by   TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      is_active    INTEGER NOT NULL DEFAULT 1
    );
  `);
  runMigrations(db);
  return db;
}

describe('reputation retention — durable store (docs §1.1, §2.1)', () => {
  let db: ReturnType<typeof Database>;

  beforeAll(() => {
    db = createMigratedDb();
  });

  afterAll(() => {
    db.close();
  });

  it('persists exactly the documented columns and no lifecycle columns', () => {
    const columns = (
      db.prepare(`PRAGMA table_info(reputation_entries)`).all() as Array<{
        name: string;
        notnull: number;
      }>
    ).map(column => column.name);

    expect(columns.sort()).toEqual(
      [
        'comment',
        'context_id',
        'created_at',
        'id',
        'rating',
        'reviewer_id',
        'target_id',
      ].sort(),
    );

    // The doc's central retention claim: rows carry no expiry, no soft-delete
    // marker, and no mutation timestamp — they are append-only and kept
    // indefinitely.
    expect(columns).not.toContain('deleted_at');
    expect(columns).not.toContain('updated_at');
    expect(columns).not.toContain('expires_at');
  });

  it('exposes no update, delete, or purge path on the repository', () => {
    const repo = new ReputationRepository(db);
    const surface = [
      ...Object.getOwnPropertyNames(ReputationRepository.prototype),
      ...Object.keys(repo),
    ];

    for (const forbidden of ['update', 'delete', 'remove', 'softDelete', 'purge', 'restore']) {
      expect(surface).not.toContain(forbidden);
    }

    // Positive control — the append-only read/write surface the doc lists.
    expect(surface).toEqual(
      expect.arrayContaining(['create', 'findById', 'findByTargetId', 'count']),
    );
  });
});

describe('reputation retention — read cache (docs §1.5, §2.3)', () => {
  it('defaults to a 60 second TTL and 500 entries', () => {
    const cache = new ReputationLruCache<string>();

    expect(DEFAULT_REPUTATION_CACHE_TTL_MS).toBe(60_000);
    expect(DEFAULT_REPUTATION_CACHE_MAX_ENTRIES).toBe(500);
    expect(cache.ttlMs).toBe(60_000);
    expect(cache.maxEntries).toBe(500);
  });

  it('drops an entry once it reaches the TTL boundary', () => {
    jest.useFakeTimers();
    try {
      const cache = new ReputationLruCache<string>({ ttlMs: 1_000, maxEntries: 10 });
      cache.set('target-1', 'profile');

      jest.advanceTimersByTime(999);
      expect(cache.get('target-1')).toBe('profile');

      jest.advanceTimersByTime(1);
      expect(cache.get('target-1')).toBeUndefined();
      // Expiry is destructive, not merely a read-through miss.
      expect(cache.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('evicts the least-recently-used entry at the capacity bound', () => {
    const cache = new ReputationLruCache<string>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.get('a'); // promote 'a' → 'b' is now LRU
    cache.set('c', 'C');

    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('A');
    expect(cache.get('c')).toBe('C');
  });

  it('invalidates on demand so a post-write read never serves stale data', () => {
    const cache = new ReputationLruCache<string>({ ttlMs: 60_000, maxEntries: 10 });
    cache.set('target-1', 'stale');

    expect(cache.invalidate('target-1')).toBe(true);
    expect(cache.get('target-1')).toBeUndefined();
    // Idempotent — invalidating an absent key is a safe no-op.
    expect(cache.invalidate('target-1')).toBe(false);
  });
});

describe('reputation retention — idempotency records (docs §1.6, §2.3)', () => {
  const key = 'reputation-retention-test-key';

  afterEach(() => {
    reputationIdempotencyStore.delete(key);
  });

  it('expires stored responses one hour after they are written', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    reputationIdempotencyStore.set({
      key,
      payloadHash: 'hash',
      result: { statusCode: 200, body: { status: 'success' } },
      createdAt,
    });

    const record = reputationIdempotencyStore.getRaw(key);
    expect(record).toBeDefined();
    expect(record!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(ONE_HOUR_MS - 5_000);
    expect(record!.expiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(ONE_HOUR_MS);
  });

  it('purges expired records and leaves live ones untouched', () => {
    const now = new Date();
    reputationIdempotencyStore.set({
      key,
      payloadHash: 'hash',
      result: { statusCode: 200, body: { status: 'success' } },
      createdAt: now,
      expiresAt: new Date(now.getTime() - 1),
    });

    expect(reputationIdempotencyStore.purgeExpired(now)).toBeGreaterThanOrEqual(1);
    expect(reputationIdempotencyStore.getRaw(key)).toBeUndefined();
  });
});

describe('reputation retention — automated retention engine (docs §2.5)', () => {
  it('has no reputation entity type, so reputation is never archived or purged', () => {
    expect(Object.values(DataEntityType)).toEqual([
      'contract',
      'user_profile',
      'transaction',
      'audit_log',
      'document',
      'message',
    ]);
    expect(Object.values(DataEntityType)).not.toContain('reputation');
  });
});

describe('reputation retention — PII in the permanent audit trail (docs §3)', () => {
  let db: ReturnType<typeof Database>;
  let scenario = 0;

  beforeAll(() => {
    db = createMigratedDb();
    ReputationService.initialize(db);
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    auditStore._reset();
  });

  function freshScenario() {
    const n = ++scenario;
    const targetId = `retention-target-${n}`;
    const reviewerId = `retention-reviewer-${n}`;
    const contextId = `retention-contract-${n}`;

    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
       VALUES (?, ?, ?, 'client', datetime('now'))`,
    ).run(targetId, targetId, `${targetId}@test.com`);
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
       VALUES (?, ?, ?, 'client', datetime('now'))`,
    ).run(reviewerId, reviewerId, `${reviewerId}@test.com`);
    db.prepare(
      `INSERT OR IGNORE INTO contracts
         (id, title, client_id, freelancer_id, amount, status, version, created_at)
       VALUES (?, ?, ?, ?, 1000, 'completed', 0, datetime('now'))`,
    ).run(contextId, `Contract ${contextId}`, reviewerId, targetId);

    return { targetId, reviewerId, contextId };
  }

  it('stores only a SHA-256 hash of the comment, never the plaintext', () => {
    const { targetId, reviewerId, contextId } = freshScenario();
    const comment = 'Delivered on time, reach me at jane.doe@example.com';

    ReputationService.createRating(reviewerId, targetId, 5, contextId, comment);

    const entries = auditService.query({ resource: 'reputation', resourceId: targetId });
    expect(entries).toHaveLength(1);

    const after = entries[0].metadata.after as { comment?: string };
    expect(after.comment).toBe(createHash('sha256').update(comment).digest('hex'));
    expect(JSON.stringify(entries[0])).not.toContain('jane.doe@example.com');
  });

  it('omits the comment field entirely when no comment was supplied', () => {
    const { targetId, reviewerId, contextId } = freshScenario();

    ReputationService.createRating(reviewerId, targetId, 4, contextId);

    const entries = auditService.query({ resource: 'reputation', resourceId: targetId });
    const after = entries[0].metadata.after as { comment?: string };
    expect(after.comment).toBeUndefined();
  });

  it('keeps the comment plaintext in the durable row it was written to', () => {
    const { targetId, reviewerId, contextId } = freshScenario();
    const comment = 'Solid collaboration throughout the engagement';

    const entry = ReputationService.createRating(reviewerId, targetId, 5, contextId, comment);

    // The doc's §3 table: plaintext lives in reputation_entries indefinitely,
    // and only there (plus the derived read paths) — not in the audit log.
    const row = db
      .prepare(`SELECT comment FROM reputation_entries WHERE id = ?`)
      .get(entry.id) as { comment: string };
    expect(row.comment).toBe(comment);
  });
});
