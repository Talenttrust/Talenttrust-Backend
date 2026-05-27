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
import Database from 'better-sqlite3';
import { ConflictError } from '../errors/appError';

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
});
