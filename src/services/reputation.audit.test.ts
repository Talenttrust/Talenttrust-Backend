/**
 * Reputation Service — Audit Trail Tests
 *
 * Issue #863: reputation mutations must leave an audit trail (actor, action,
 * before/after summary, timestamp) with a read view, bounded storage, and
 * secret redaction.
 *
 * Most of this already existed generically before this change: TalentTrust
 * has a mature, hash-chained, append-only audit subsystem (src/audit/*)
 * mounted at `/audit` (`GET /audit`, `GET /audit/:id`, cursor pagination
 * bounded to 1-100 entries/page — see sqliteRepository.ts / store.ts), and
 * `ReputationService.createRating` already called into it. What was missing:
 *   1. An explicit before/after summary in the audit metadata (this PR adds
 *      `metadata.before.totalRatings` / `metadata.after.totalRatings`, see
 *      reputation.service.ts).
 *   2. Test coverage proving the reputation audit trail actually works
 *      end-to-end: entry shape, read-view retrieval, redaction, hash-chain
 *      integrity, and that rejected (guard-failed) attempts do NOT produce
 *      an entry — this suite.
 *
 * SCOPE NOTE on "cover create/update/delete audit entries": reputation
 * ratings are immutable by design — `ReputationRepository` has no update or
 * delete method for entries (append-only + a DB `UNIQUE(reviewer_id,
 * target_id, context_id)` constraint is exactly what prevents a reviewer
 * from overwriting or removing a past rating, which is the anti-abuse
 * property `createRating`'s guards exist to protect). There is no
 * update/delete reputation mutation anywhere in this codebase, so there is
 * nothing to audit there. Inventing one to satisfy a generic issue template
 * would weaken, not strengthen, the reputation system's integrity. This
 * suite instead covers every mutation that actually exists: successful
 * create, and rejected create attempts (which correctly produce no entry).
 *
 * This test does NOT mock `../audit/service` — unlike reputation.service.test.ts
 * — because the whole point is to exercise the real audit store.
 */

import { ReputationService } from './reputation.service';
import { auditService } from '../audit/service';
import { auditStore } from '../audit/store';
import { getDb } from '../db/database';
import Database from '../db/betterSqlite3';
import { createHash } from 'crypto';

function insertUser(db: ReturnType<typeof Database>, id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, 'client', datetime('now'))`,
  ).run(id, id, `${id}@test.com`);
}

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

describe('ReputationService.createRating — audit trail', () => {
  let db: ReturnType<typeof Database>;
  let scenarioCounter = 0;

  beforeAll(() => {
    db = getDb(':memory:');
    ReputationService.initialize(db);
  });

  beforeEach(() => {
    auditStore._reset();
  });

  /**
   * Builds a fully isolated target/reviewer/contract set for a single test,
   * so tests never interfere with each other's rating counts or duplicate
   * guards regardless of execution order.
   */
  function freshScenario() {
    const n = ++scenarioCounter;
    const targetId = `audit-target-${n}`;
    const reviewerA = `audit-reviewer-a-${n}`;
    const reviewerB = `audit-reviewer-b-${n}`;
    const contextA = `audit-contract-a-${n}`;
    const contextB = `audit-contract-b-${n}`;

    insertUser(db, targetId);
    insertUser(db, reviewerA);
    insertUser(db, reviewerB);
    insertContract(db, contextA, reviewerA, targetId);
    insertContract(db, contextB, reviewerB, targetId);

    return { targetId, reviewerA, reviewerB, contextA, contextB };
  }

  it('creates exactly one audit entry with actor, action, resource, resourceId, and timestamp', () => {
    const { targetId, reviewerA, contextA } = freshScenario();

    const beforeTs = new Date().toISOString();
    ReputationService.createRating(reviewerA, targetId, 5, contextA, 'Great work');
    const afterTs = new Date().toISOString();

    const entries = auditService.query({ resource: 'reputation', resourceId: targetId });
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.action).toBe('REPUTATION_UPDATED');
    expect(entry.actor).toBe(reviewerA);
    expect(entry.resource).toBe('reputation');
    expect(entry.resourceId).toBe(targetId);
    expect(entry.timestamp >= beforeTs && entry.timestamp <= afterTs).toBe(true);
  });

  it('records a before/after summary of the target rating count for each mutation', () => {
    const { targetId, reviewerA, reviewerB, contextA, contextB } = freshScenario();

    ReputationService.createRating(reviewerA, targetId, 4, contextA);
    ReputationService.createRating(reviewerB, targetId, 2, contextB);

    const entries = auditService.query({ resource: 'reputation', resourceId: targetId });
    expect(entries).toHaveLength(2);

    expect(entries[0].metadata.before).toEqual({ totalRatings: 0 });
    expect(entries[0].metadata.after).toMatchObject({ totalRatings: 1, rating: 4 });

    expect(entries[1].metadata.before).toEqual({ totalRatings: 1 });
    expect(entries[1].metadata.after).toMatchObject({ totalRatings: 2, rating: 2 });
  });

  it('is retrievable through the audit read view by resource+resourceId, and by id', () => {
    const { targetId, reviewerA, contextA } = freshScenario();
    const created = ReputationService.createRating(reviewerA, targetId, 3, contextA);

    const viaQuery = auditService.query({ resource: 'reputation', resourceId: targetId });
    expect(viaQuery).toHaveLength(1);
    const entryId = viaQuery[0].id;

    const viaGetById = auditService.getById(entryId);
    expect(viaGetById).toBeDefined();
    expect(viaGetById?.resourceId).toBe(targetId);

    const viaCursor = auditService.queryWithCursor({ resource: 'reputation', resourceId: targetId });
    expect(viaCursor.entries).toHaveLength(1);
    expect(viaCursor.entries[0].id).toBe(entryId);

    // entryId round-trips through the audit metadata too, linking the
    // reputation row back to its audit entry for incident review.
    expect((viaGetById?.metadata as { entryId: string }).entryId).toBe(created.id);
  });

  it('never stores the raw comment text in the audit log — only its SHA-256 hash', () => {
    const { targetId, reviewerA, contextA } = freshScenario();
    const secretLookingComment = 'Contact me at attacker@example.com, password: hunter2';
    ReputationService.createRating(reviewerA, targetId, 5, contextA, secretLookingComment);

    const [entry] = auditService.query({ resource: 'reputation', resourceId: targetId });
    const serialized = JSON.stringify(entry);

    expect(serialized).not.toContain(secretLookingComment);
    expect(serialized).not.toContain('attacker@example.com');
    expect(serialized).not.toContain('hunter2');

    const storedHash = (entry.metadata.after as { comment?: string }).comment;
    expect(storedHash).toBe(createHash('sha256').update(secretLookingComment).digest('hex'));
  });

  it('does not create an audit entry when a guard rejects the mutation', () => {
    const { targetId, contextA } = freshScenario();
    // Self-rating is rejected by Guard 1 before any DB write happens.
    expect(() => ReputationService.createRating(targetId, targetId, 5, contextA)).toThrow();

    const entries = auditService.query({ resource: 'reputation', resourceId: targetId });
    expect(entries).toHaveLength(0);
  });

  it('keeps the hash chain valid across multiple reputation writes', () => {
    const { targetId, reviewerA, reviewerB, contextA, contextB } = freshScenario();
    ReputationService.createRating(reviewerA, targetId, 4, contextA);
    ReputationService.createRating(reviewerB, targetId, 5, contextB);

    const report = auditService.verifyIntegrity();
    expect(report.valid).toBe(true);
    expect(report.totalEntries).toBe(2);
  });

  it('bounds a single query page to at most 100 entries via cursor pagination', () => {
    const result = auditService.queryWithCursor({ resource: 'reputation', limit: 500 });
    expect(result.limit).toBeLessThanOrEqual(100);
  });
});
