/**
 * Reputation Service — Concurrency Smoke Tests
 *
 * Issue #864: the reputation write path was never exercised under
 * concurrent dispatch, which could hide a lost-update or duplicate-write
 * bug in ReputationService.createRating's check-then-act duplicate guard
 * (find existing entry, then insert).
 *
 * IMPORTANT SCOPE NOTE: the HTTP endpoint wired to `PUT /api/v1/reputation/:id`
 * (ReputationController.createRating) does not actually call
 * `ReputationService.createRating` — it calls the non-existent
 * `(ReputationService as any).updateProfile`, which is always undefined, so it
 * silently falls through to `ReputationService.getProfile` and never persists
 * anything (see reputation.controller.ts:73-75, and reputation.controller.test.ts
 * which asserts exactly this behaviour). That is a pre-existing functional bug,
 * not a concurrency bug, and is out of scope for this issue — fixing it would
 * change response contracts covered by other tests. These tests instead target
 * `ReputationService.createRating` / `ReputationRepository` directly: the real,
 * fully-implemented write path (already unit-tested for anti-abuse guards in
 * reputation.service.test.ts, but never under concurrent dispatch).
 *
 * All calls here go through a real in-memory SQLite database (no mocked
 * repository), are bounded to a fixed, small N, and touch no network or
 * timers, so the suite is deterministic.
 */

import { ReputationService } from './reputation.service';
import { getDb } from '../db/database';
import Database from '../db/betterSqlite3';
import { ConflictError } from '../errors/appError';

jest.mock('../audit/service', () => ({
  auditService: {
    log: jest.fn(),
  },
}));

const TARGET_ID = 'concurrency-target';
const CONCURRENCY_N = 20;

function insertContract(
  db: ReturnType<typeof Database>,
  id: string,
  clientId: string,
  freelancerId: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO contracts
       (id, title, client_id, freelancer_id, amount, status, version, created_at)
     VALUES (?, ?, ?, ?, 1000, 'completed', 0, datetime('now'))`,
  ).run(id, `Contract ${id}`, clientId, freelancerId);
}

function insertUser(db: ReturnType<typeof Database>, id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, 'client', datetime('now'))`,
  ).run(id, id, `${id}@test.com`);
}

function reputationRowCount(db: ReturnType<typeof Database>, targetId: string): number {
  const row = db
    .prepare<[string], { c: number }>(
      'SELECT COUNT(*) AS c FROM reputation_entries WHERE target_id = ?',
    )
    .get(targetId);
  return row?.c ?? 0;
}

/**
 * Dispatches `fn` on a fresh microtask so concurrent calls are queued
 * together via Promise.all rather than run one at a time by the caller —
 * the closest approximation of "concurrent requests" available for a
 * synchronous (better-sqlite3) write path in a single Node process.
 */
function deferred<T>(fn: () => T): Promise<T> {
  return Promise.resolve().then(fn);
}

describe('ReputationService.createRating — concurrency smoke tests', () => {
  let db: ReturnType<typeof Database>;

  beforeAll(() => {
    db = getDb(':memory:');
    ReputationService.initialize(db);
    insertUser(db, TARGET_ID);
  });

  it('accepts N concurrent ratings from distinct reviewers with no lost updates', async () => {
    const reviewerIds = Array.from({ length: CONCURRENCY_N }, (_, i) => `reviewer-${i}`);
    reviewerIds.forEach((reviewerId, i) => {
      insertUser(db, reviewerId);
      insertContract(db, `contract-distinct-${i}`, reviewerId, TARGET_ID);
    });

    const results = await Promise.all(
      reviewerIds.map((reviewerId, i) =>
        deferred(() =>
          ReputationService.createRating(reviewerId, TARGET_ID, (i % 5) + 1, `contract-distinct-${i}`),
        ),
      ),
    );

    // No lost updates: every one of the N concurrent writes actually persisted.
    expect(results).toHaveLength(CONCURRENCY_N);
    expect(reputationRowCount(db, TARGET_ID)).toBe(CONCURRENCY_N);

    // Read-after-write consistency: the profile reflects the full batch
    // immediately, with no dropped or duplicated entries.
    const profile = ReputationService.getProfile(TARGET_ID);
    expect(profile.totalRatings).toBe(CONCURRENCY_N);
    expect(profile.reviews).toHaveLength(CONCURRENCY_N);
    const uniqueReviewers = new Set(profile.reviews.map((r) => r.reviewerId));
    expect(uniqueReviewers.size).toBe(CONCURRENCY_N);
  });

  it('resolves concurrent duplicate ratings (same reviewer/target/context) to exactly one persisted entry', async () => {
    const reviewerId = 'dup-reviewer';
    const contextId = 'contract-duplicate';
    insertUser(db, reviewerId);
    insertContract(db, contextId, reviewerId, TARGET_ID);

    const attempts = 10;
    const outcomes = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        deferred(() => ReputationService.createRating(reviewerId, TARGET_ID, 5, contextId)),
      ),
    );

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );

    // Exactly one writer wins; every other concurrent attempt is rejected —
    // never silently dropped, never double-written.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(attempts - 1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ConflictError);
    }

    // The DB agrees: no duplicate row was ever created for this composite key.
    const row = db
      .prepare<[string, string, string], { c: number }>(
        'SELECT COUNT(*) AS c FROM reputation_entries WHERE reviewer_id = ? AND target_id = ? AND context_id = ?',
      )
      .get(reviewerId, TARGET_ID, contextId);
    expect(row?.c).toBe(1);
  });

  it('is bounded and deterministic: fixed N, no timers, no network, same result on repeat', async () => {
    const isolatedTarget = 'concurrency-target-repeat';
    insertUser(db, isolatedTarget);

    async function runBatch(contractPrefix: string): Promise<number> {
      const reviewerIds = Array.from({ length: 5 }, (_, i) => `${contractPrefix}-reviewer-${i}`);
      reviewerIds.forEach((reviewerId, i) => {
        insertUser(db, reviewerId);
        insertContract(db, `${contractPrefix}-contract-${i}`, reviewerId, isolatedTarget);
      });
      await Promise.all(
        reviewerIds.map((reviewerId, i) =>
          deferred(() =>
            ReputationService.createRating(
              reviewerId,
              isolatedTarget,
              3,
              `${contractPrefix}-contract-${i}`,
            ),
          ),
        ),
      );
      return reputationRowCount(db, isolatedTarget);
    }

    const first = await runBatch('batch-a');
    expect(first).toBe(5);

    const second = await runBatch('batch-b');
    expect(second).toBe(10);
  });
});
