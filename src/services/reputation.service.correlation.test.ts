import { ReputationService } from './reputation.service';
import { auditService } from '../audit/service';
import { getDb } from '../db/database';
import Database from '../db/betterSqlite3';

// Mock the audit service to capture log calls
jest.mock('../audit/service', () => ({
  auditService: {
    log: jest.fn(),
  },
}));

const REVIEWER_ID = 'reviewer-123';
const TARGET_ID = 'target-456';
const CONTEXT_ID = 'contract-abc';
const TEST_CORRELATION_ID = 'svc-test-corr-id-abc123';

function insertContract(
  db: ReturnType<typeof Database>,
  id: string,
  clientId: string = REVIEWER_ID,
  freelancerId: string = TARGET_ID,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO contracts
       (id, title, client_id, freelancer_id, amount, status, version, created_at)
     VALUES (?, ?, ?, ?, 1000, 'completed', 0, datetime('now'))`,
  ).run(id, `Contract ${id}`, clientId, freelancerId);
}

function seedInMemoryDb(): ReturnType<typeof Database> {
  const db = getDb(':memory:');
  db.exec(`
    INSERT OR IGNORE INTO users (id, username, email, role, created_at)
    VALUES
      ('${REVIEWER_ID}', 'reviewer01', 'reviewer@test.com', 'client', datetime('now')),
      ('${TARGET_ID}',   'target01',   'target@test.com',   'freelancer', datetime('now'));
  `);
  insertContract(db, CONTEXT_ID);
  return db;
}

describe('ReputationService – correlation ID propagation', () => {
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    jest.clearAllMocks();
    db = seedInMemoryDb();
    ReputationService.initialize(db);
    db.exec('DELETE FROM reputation_entries');
  });

  describe('createRating', () => {
    it('propagates correlationId to auditService.log when provided', () => {
      ReputationService.createRating(
        REVIEWER_ID,
        TARGET_ID,
        5,
        CONTEXT_ID,
        'Great work!',
        TEST_CORRELATION_ID
      );

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'REPUTATION_UPDATED',
          correlationId: TEST_CORRELATION_ID,
        })
      );
    });

    it('works normally and leaves correlationId undefined when not provided', () => {
      ReputationService.createRating(
        REVIEWER_ID,
        TARGET_ID,
        5,
        CONTEXT_ID,
        'Great work!'
      );

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'REPUTATION_UPDATED',
          correlationId: undefined,
        })
      );
    });
  });

  describe('updateProfile', () => {
    const payload = {
      reviewerId: REVIEWER_ID,
      rating: 4,
      contextId: CONTEXT_ID,
      comment: 'Nice',
    };

    it('forwards correlationId to createRating and audit log', () => {
      ReputationService.updateProfile(TARGET_ID, payload, TEST_CORRELATION_ID);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'REPUTATION_UPDATED',
          correlationId: TEST_CORRELATION_ID,
        })
      );
    });
  });

  describe('createBulkRatings', () => {
    const bulkItems = [
      {
        reviewerId: REVIEWER_ID,
        targetId: TARGET_ID,
        rating: 4,
        contextId: CONTEXT_ID,
        comment: 'Comment 1',
      },
    ];

    it('forwards correlationId to each item creation and audit log', () => {
      ReputationService.createBulkRatings(bulkItems, TEST_CORRELATION_ID);

      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'REPUTATION_UPDATED',
          correlationId: TEST_CORRELATION_ID,
        })
      );
    });
  });
});
