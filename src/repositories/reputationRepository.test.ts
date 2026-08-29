/**
 * ReputationRepository Tests
 * 
 * Tests the SQLite-backed reputation repository for:
 * - CRUD operations
 * - Uniqueness constraint enforcement
 * - Contract participation verification
 * - Data integrity
 */

import { ReputationRepository, CreateReputationEntry } from './reputationRepository';
import { getDb, closeDb } from '../db/database';
import Database from '../db/betterSqlite3';
import { ConflictError } from '../errors/appError';
import { encodeCursor, decodeCursor } from '../contracts/cursor.repository';
import { CURSOR_MAX_LIMIT, CURSOR_DEFAULT_LIMIT } from '../contracts/cursor.types';

describe('ReputationRepository', () => {
  let db: Database.Database;
  let repo: ReputationRepository;

  const testUser1Id = 'test-user-1-repo';
  const testUser2Id = 'test-user-2-repo';
  const testContractId = 'test-contract-repo';

  beforeAll(() => {
    db = getDb(':memory:');
    repo = new ReputationRepository(db);

    // Insert test users and contract
    db.exec(`
      INSERT INTO users (id, username, email, role, created_at)
      VALUES 
        ('${testUser1Id}', 'user1', 'user1@test.com', 'client', datetime('now')),
        ('${testUser2Id}', 'user2', 'user2@test.com', 'freelancer', datetime('now'));
      
      INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
      VALUES ('${testContractId}', 'Test Contract', '${testUser1Id}', '${testUser2Id}', 1000, 'completed', 0, datetime('now'));
    `);
  });

  afterAll(() => {
    closeDb();
  });

  describe('create', () => {
    it('should create a valid reputation entry', () => {
      const entry: CreateReputationEntry = {
        reviewerId: testUser1Id,
        targetId: testUser2Id,
        rating: 5,
        comment: 'Excellent work!',
        contextId: testContractId,
      };

      const result = repo.create(entry);

      expect(result.id).toBeDefined();
      expect(result.reviewerId).toBe(testUser1Id);
      expect(result.targetId).toBe(testUser2Id);
      expect(result.rating).toBe(5);
      expect(result.comment).toBe('Excellent work!');
      expect(result.contextId).toBe(testContractId);
      expect(result.createdAt).toBeDefined();
    });

    it('should create entry without comment', () => {
      const entry: CreateReputationEntry = {
        reviewerId: testUser2Id,
        targetId: testUser1Id,
        rating: 4,
        contextId: testContractId,
      };

      const result = repo.create(entry);

      expect(result.comment).toBeUndefined();
      expect(result.rating).toBe(4);
    });

    it('should throw ConflictError for duplicate entry', () => {
      const entry: CreateReputationEntry = {
        reviewerId: testUser1Id,
        targetId: testUser2Id,
        rating: 3,
        contextId: testContractId,
      };

      expect(() => repo.create(entry)).toThrow(ConflictError);
      expect(() => repo.create(entry)).toThrow('Rating already exists');
    });

    it('should accept boundary rating (1)', () => {
      const entry: CreateReputationEntry = {
        reviewerId: testUser1Id,
        targetId: testUser2Id,
        rating: 1,
        contextId: testContractId,
      };

      // This will fail due to duplicate, so we use different context
      const uniqueContractId = 'unique-contract-1';
      db.exec(`
        INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES ('${uniqueContractId}', 'Test', '${testUser1Id}', '${testUser2Id}', 500, 'completed', 0, datetime('now'));
      `);

      entry.contextId = uniqueContractId;
      const result = repo.create(entry);
      expect(result.rating).toBe(1);
    });

    it('should accept boundary rating (5)', () => {
      const uniqueContractId = 'unique-contract-2';
      db.exec(`
        INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES ('${uniqueContractId}', 'Test', '${testUser1Id}', '${testUser2Id}', 600, 'completed', 0, datetime('now'));
      `);

      const entry: CreateReputationEntry = {
        reviewerId: testUser2Id,
        targetId: testUser1Id,
        rating: 5,
        contextId: uniqueContractId,
      };

      const result = repo.create(entry);
      expect(result.rating).toBe(5);
    });
  });

  describe('findByReviewerTargetContext', () => {
    it('should find existing entry', () => {
      const result = repo.findByReviewerTargetContext(
        testUser1Id,
        testUser2Id,
        testContractId
      );

      expect(result).toBeDefined();
      expect(result?.reviewerId).toBe(testUser1Id);
      expect(result?.targetId).toBe(testUser2Id);
    });

    it('should return undefined for non-existent entry', () => {
      const result = repo.findByReviewerTargetContext(
        'non-existent-reviewer',
        'non-existent-target',
        'non-existent-context'
      );

      expect(result).toBeUndefined();
    });
  });

  describe('findByTargetId', () => {
    it('should return all entries for a target', () => {
      const entries = repo.findByTargetId(testUser2Id);

      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].targetId).toBe(testUser2Id);
    });

    it('should return empty array for target with no ratings', () => {
      const entries = repo.findByTargetId('no-ratings-user');
      expect(entries).toEqual([]);
    });
  });

  describe('verifyContractParticipation', () => {
    it('should return true for contract client', () => {
      const result = repo.verifyContractParticipation(testContractId, testUser1Id);
      expect(result).toBe(true);
    });

    it('should return true for contract freelancer', () => {
      const result = repo.verifyContractParticipation(testContractId, testUser2Id);
      expect(result).toBe(true);
    });

    it('should return false for non-participant', () => {
      const result = repo.verifyContractParticipation(testContractId, 'non-participant');
      expect(result).toBe(false);
    });

    it('should return false for non-existent contract', () => {
      const result = repo.verifyContractParticipation('fake-contract', testUser1Id);
      expect(result).toBe(false);
    });
  });

  describe('findById', () => {
    it('should find entry by ID', () => {
      const entries = repo.findByTargetId(testUser2Id);
      const entryId = entries[0].id;

      const result = repo.findById(entryId);
      expect(result).toBeDefined();
      expect(result?.id).toBe(entryId);
    });

    it('should return undefined for non-existent ID', () => {
      const result = repo.findById('non-existent-id');
      expect(result).toBeUndefined();
    });
  });

  describe('count', () => {
    it('should return correct count of entries', () => {
      const count = repo.count();
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Cursor-paginated findByTargetIdPaginated ──────────────────────────

  describe('findByTargetIdPaginated', () => {
    const paginatedTargetId = 'paginated-target-1';
    let entryIds: string[] = [];

    beforeAll(() => {
      // Seed users and contracts for the paginated target
      db.exec(`
        INSERT OR IGNORE INTO users (id, username, email, role, created_at)
        VALUES
          ('rev-a', 'reva', 'reva@test.com', 'client', datetime('now')),
          ('rev-b', 'revb', 'revb@test.com', 'client', datetime('now')),
          ('rev-c', 'revc', 'revc@test.com', 'client', datetime('now')),
          ('${paginatedTargetId}', 'pgtarget', 'pgtarget@test.com', 'freelancer', datetime('now'));

        INSERT OR IGNORE INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES
          ('ctx-pag-1', 'C1', 'rev-a', '${paginatedTargetId}', 100, 'completed', 0, datetime('now')),
          ('ctx-pag-2', 'C2', 'rev-b', '${paginatedTargetId}', 200, 'completed', 0, datetime('now')),
          ('ctx-pag-3', 'C3', 'rev-c', '${paginatedTargetId}', 300, 'completed', 0, datetime('now'));
      `);

      // Create 25 reputation entries with staggered timestamps for reproducible ordering
      for (let i = 0; i < 25; i++) {
        const createdAt = new Date(Date.UTC(2024, 0, 1 + i)).toISOString();
        // Use raw insert with unique context per entry to avoid UNIQUE constraint
        const contractId = `ctx-pag-${String(i).padStart(3, '0')}`;
        db.prepare(
          `INSERT OR IGNORE INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
           VALUES (?, ?, 'rev-a', ?, 100, 'completed', 0, datetime('now'))`
        ).run(contractId, `C-${i}`, paginatedTargetId);

        const id = require('crypto').randomUUID();
        entryIds.push(id);
        db.prepare(
          `INSERT INTO reputation_entries (id, reviewer_id, target_id, rating, comment, context_id, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`
        ).run(id, 'rev-a', paginatedTargetId, (i % 5) + 1, contractId, createdAt);
      }
    });

    describe('first page (no cursor)', () => {
      it('returns default page size of CURSOR_DEFAULT_LIMIT items', () => {
        const page = repo.findByTargetIdPaginated(paginatedTargetId);
        expect(page.data).toHaveLength(CURSOR_DEFAULT_LIMIT);
        expect(page.limit).toBe(CURSOR_DEFAULT_LIMIT);
        expect(page.hasNextPage).toBe(true);
        expect(page.nextCursor).not.toBeNull();
      });

      it('returns items ordered newest-first by created_at DESC, id DESC', () => {
        const page = repo.findByTargetIdPaginated(paginatedTargetId, { limit: 25 });
        for (let i = 1; i < page.data.length; i++) {
          const prev = page.data[i - 1];
          const curr = page.data[i];
          // Previous should be newer or equal with higher id
          if (prev.createdAt === curr.createdAt) {
            expect(prev.id > curr.id).toBe(true);
          } else {
            expect(prev.createdAt > curr.createdAt).toBe(true);
          }
        }
      });

      it('round-trips cursor: decode(nextCursor) returns valid CursorPosition', () => {
        const page = repo.findByTargetIdPaginated(paginatedTargetId, { limit: 5 });
        expect(page.nextCursor).not.toBeNull();
        const pos = decodeCursor(page.nextCursor!);
        expect(typeof pos.createdAt).toBe('string');
        expect(typeof pos.id).toBe('string');
        expect(isNaN(Date.parse(pos.createdAt))).toBe(false);
      });
    });

    describe('custom limit', () => {
      it('accepts limit = 1', () => {
        const page = repo.findByTargetIdPaginated(paginatedTargetId, { limit: 1 });
        expect(page.data).toHaveLength(1);
        expect(page.limit).toBe(1);
      });

      it('accepts limit = CURSOR_MAX_LIMIT', () => {
        const page = repo.findByTargetIdPaginated(paginatedTargetId, { limit: CURSOR_MAX_LIMIT });
        expect(page.data.length).toBeLessThanOrEqual(CURSOR_MAX_LIMIT);
        expect(page.limit).toBe(CURSOR_MAX_LIMIT);
      });

      it('throws for limit > CURSOR_MAX_LIMIT', () => {
        expect(() =>
          repo.findByTargetIdPaginated(paginatedTargetId, { limit: CURSOR_MAX_LIMIT + 1 }),
        ).toThrow(/exceeds maximum allowed page size/);
      });

      it('throws for limit = 0', () => {
        expect(() =>
          repo.findByTargetIdPaginated(paginatedTargetId, { limit: 0 }),
        ).toThrow();
      });

      it('throws for negative limit', () => {
        expect(() =>
          repo.findByTargetIdPaginated(paginatedTargetId, { limit: -5 }),
        ).toThrow();
      });
    });

    describe('cursor-based traversal', () => {
      it('pages through all items using cursor chain', () => {
        const pageSize = 7;
        const allIds: string[] = [];
        let cursor: string | undefined;
        let pages = 0;

        do {
          const page = repo.findByTargetIdPaginated(paginatedTargetId, {
            limit: pageSize,
            cursor,
          });
          allIds.push(...page.data.map(e => e.id));
          cursor = page.nextCursor ?? undefined;
          pages++;
        } while (cursor);

        // All 25 entries should be collected exactly once
        expect(allIds).toHaveLength(25);
        // No duplicates
        expect(new Set(allIds).size).toBe(25);
        // Should span multiple pages (> 3 since 25/7 ≈ 3.57)
        expect(pages).toBeGreaterThan(2);
      });

      it('returns null nextCursor on the last page', () => {
        const all = repo.findByTargetIdPaginated(paginatedTargetId, { limit: 25 });
        expect(all.hasNextPage).toBe(false);
        expect(all.nextCursor).toBeNull();
      });

      it('returns exact page boundary correctly (pageSize = 5, 25 total → 5 pages)', () => {
        let cursor: string | undefined;
        for (let p = 0; p < 5; p++) {
          const page = repo.findByTargetIdPaginated(paginatedTargetId, {
            limit: 5,
            cursor,
          });
          expect(page.data).toHaveLength(5);
          if (p < 4) {
            expect(page.hasNextPage).toBe(true);
            expect(page.nextCursor).not.toBeNull();
          } else {
            expect(page.hasNextPage).toBe(false);
            expect(page.nextCursor).toBeNull();
          }
          cursor = page.nextCursor ?? undefined;
        }
      });

      it('second page contains different items than first page', () => {
        const page1 = repo.findByTargetIdPaginated(paginatedTargetId, { limit: 10 });
        const page2 = repo.findByTargetIdPaginated(paginatedTargetId, {
          limit: 10,
          cursor: page1.nextCursor!,
        });

        const ids1 = new Set(page1.data.map(e => e.id));
        const ids2 = new Set(page2.data.map(e => e.id));

        // No overlap
        for (const id of ids2) {
          expect(ids1.has(id)).toBe(false);
        }
      });
    });

    describe('edge cases', () => {
      it('returns empty page for target with no ratings', () => {
        const page = repo.findByTargetIdPaginated('no-ratings-user');
        expect(page.data).toEqual([]);
        expect(page.hasNextPage).toBe(false);
        expect(page.nextCursor).toBeNull();
      });

      it('returns empty page for target with no ratings even with cursor', () => {
        const cursor = encodeCursor({ createdAt: '2024-01-01T00:00:00.000Z', id: 'some-id' });
        const page = repo.findByTargetIdPaginated('no-ratings-user', { cursor });
        expect(page.data).toEqual([]);
        expect(page.hasNextPage).toBe(false);
        expect(page.nextCursor).toBeNull();
      });

      it('throws on a completely garbage cursor string', () => {
        expect(() =>
          repo.findByTargetIdPaginated(paginatedTargetId, { cursor: 'not-a-valid-cursor' }),
        ).toThrow(/Invalid pagination cursor/);
      });

      it('throws on a cursor with missing createdAt field', () => {
        const bad = Buffer.from(JSON.stringify({ id: 'some-id' })).toString('base64url');
        expect(() =>
          repo.findByTargetIdPaginated(paginatedTargetId, { cursor: bad }),
        ).toThrow(/missing required fields/);
      });

      it('throws on a cursor with an invalid createdAt date', () => {
        const bad = Buffer.from(
          JSON.stringify({ createdAt: 'not-a-date', id: 'some-id' }),
        ).toString('base64url');
        expect(() =>
          repo.findByTargetIdPaginated(paginatedTargetId, { cursor: bad }),
        ).toThrow(/not a valid date/);
      });

      it('returns empty page when cursor points beyond all data', () => {
        // Use a cursor with a very old timestamp to page "before" all data
        const cursor = encodeCursor({
          createdAt: '2020-01-01T00:00:00.000Z',
          id: '00000000-0000-0000-0000-000000000000',
        });
        const page = repo.findByTargetIdPaginated(paginatedTargetId, { cursor });
        // Since we order DESC, a cursor pointing to 2020 should be before all data
        expect(page.data).toEqual([]);
        expect(page.hasNextPage).toBe(false);
        expect(page.nextCursor).toBeNull();
      });

      it('returns only items for the specified targetId', () => {
        const page = repo.findByTargetIdPaginated(paginatedTargetId, { limit: 25 });
        for (const entry of page.data) {
          expect(entry.targetId).toBe(paginatedTargetId);
        }
      });

      it('handles limit that exceeds total count — returns all items', () => {
        const page = repo.findByTargetIdPaginated(paginatedTargetId, { limit: 100 });
        expect(page.data).toHaveLength(25);
        expect(page.hasNextPage).toBe(false);
        expect(page.nextCursor).toBeNull();
      });

      it('nextCursor is a valid base64url string', () => {
        const page = repo.findByTargetIdPaginated(paginatedTargetId, { limit: 3 });
        expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      });

      it('one-item page has correct nextCursor pointing to that item', () => {
        const page = repo.findByTargetIdPaginated(paginatedTargetId, { limit: 1 });
        expect(page.data).toHaveLength(1);
        const pos = decodeCursor(page.nextCursor!);
        expect(pos.id).toBe(page.data[0].id);
        expect(pos.createdAt).toBe(page.data[0].createdAt);
      });
    });
  });
});
