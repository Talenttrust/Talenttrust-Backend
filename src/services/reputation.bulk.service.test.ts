import { ReputationService } from './reputation.service';
import { getDb } from '../db/database';
import Database from '../db/betterSqlite3';

jest.mock('../audit/service', () => ({
  auditService: {
    log: jest.fn(),
  },
}));

const REVIEWER_A = 'reviewer-a';
const REVIEWER_B = 'reviewer-b';
const TARGET = 'target-user';
const OUTSIDER = 'outsider-user';

let contractCounter = 0;
function nextContractId(): string {
  contractCounter++;
  return `550e8400-e29b-41d4-a716-${String(contractCounter).padStart(12, '0')}`;
}

function insertContract(db: ReturnType<typeof Database>, id: string, client: string, freelancer: string) {
  db.prepare(
    `INSERT OR IGNORE INTO contracts
       (id, title, client_id, freelancer_id, amount, status, version, created_at)
     VALUES (?, ?, ?, ?, 1000, 'completed', 0, datetime('now'))`
  ).run(id, `Contract ${id}`, client, freelancer);
}

describe('ReputationService.createBulkRatings', () => {
  let db: ReturnType<typeof Database>;

  beforeAll(() => {
    db = getDb(':memory:');
    ReputationService.initialize(db);

    db.exec(`
      INSERT OR IGNORE INTO users (id, username, email, role, created_at)
      VALUES
        ('${REVIEWER_A}', 'reviewerA', 'a@test.com', 'client', datetime('now')),
        ('${REVIEWER_B}', 'reviewerB', 'b@test.com', 'client', datetime('now')),
        ('${TARGET}',     'target01', 't@test.com', 'freelancer', datetime('now')),
        ('${OUTSIDER}',   'outsider', 'o@test.com', 'client', datetime('now'));
    `);
  });

  it('returns all-success for a single valid item', () => {
    const ctx = nextContractId();
    insertContract(db, ctx, REVIEWER_A, TARGET);

    const results = ReputationService.createBulkRatings([
      { reviewerId: REVIEWER_A, targetId: TARGET, rating: 5, contextId: ctx },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].index).toBe(0);
    expect(results[0].data).toBeDefined();
    expect(results[0].data!.rating).toBe(5);
  });

  it('processes multiple valid items independently', () => {
    const ctx1 = nextContractId();
    const ctx2 = nextContractId();
    insertContract(db, ctx1, REVIEWER_A, TARGET);
    insertContract(db, ctx2, REVIEWER_B, TARGET);

    const results = ReputationService.createBulkRatings([
      { reviewerId: REVIEWER_A, targetId: TARGET, rating: 4, contextId: ctx1 },
      { reviewerId: REVIEWER_B, targetId: TARGET, rating: 3, contextId: ctx2 },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
  });

  it('returns conflict error for a duplicate rating', () => {
    const ctx = nextContractId();
    insertContract(db, ctx, REVIEWER_A, TARGET);

    // First rating succeeds
    ReputationService.createBulkRatings([
      { reviewerId: REVIEWER_A, targetId: TARGET, rating: 2, contextId: ctx },
    ]);

    // Same reviewer/target/context — duplicate
    const results = ReputationService.createBulkRatings([
      { reviewerId: REVIEWER_A, targetId: TARGET, rating: 3, contextId: ctx },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error!.code).toBe('conflict');
  });

  it('returns forbidden error for self-rating', () => {
    const ctx = nextContractId();
    insertContract(db, ctx, TARGET, REVIEWER_A);

    const results = ReputationService.createBulkRatings([
      { reviewerId: TARGET, targetId: TARGET, rating: 5, contextId: ctx },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error!.code).toBe('forbidden');
  });

  it('returns forbidden error for non-participant', () => {
    const ctx = nextContractId();
    insertContract(db, ctx, REVIEWER_A, TARGET);

    const results = ReputationService.createBulkRatings([
      { reviewerId: OUTSIDER, targetId: TARGET, rating: 5, contextId: ctx },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error!.code).toBe('forbidden');
  });

  it('returns mixed results when batch contains valid and invalid items', () => {
    const ctxGood = nextContractId();
    const ctxBad = nextContractId();
    insertContract(db, ctxGood, REVIEWER_A, TARGET);
    insertContract(db, ctxBad, REVIEWER_B, TARGET);

    const results = ReputationService.createBulkRatings([
      { reviewerId: REVIEWER_A, targetId: TARGET, rating: 1, contextId: ctxGood },
      { reviewerId: TARGET, targetId: TARGET, rating: 5, contextId: ctxBad },   // self-rating
      { reviewerId: OUTSIDER, targetId: TARGET, rating: 3, contextId: ctxBad }, // non-participant
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
    expect(results[1].error!.code).toBe('forbidden');
    expect(results[2].success).toBe(false);
    expect(results[2].error!.code).toBe('forbidden');
  });

  it('preserves correct indices across failures', () => {
    const ctx1 = nextContractId();
    const ctx2 = nextContractId();
    insertContract(db, ctx1, REVIEWER_B, TARGET);
    insertContract(db, ctx2, REVIEWER_A, TARGET);

    const results = ReputationService.createBulkRatings([
      { reviewerId: TARGET, targetId: TARGET, rating: 5, contextId: ctx1 },  // 0: self-rating → fail
      { reviewerId: REVIEWER_A, targetId: TARGET, rating: 2, contextId: ctx2 }, // 1: success
    ]);

    expect(results[0].index).toBe(0);
    expect(results[0].success).toBe(false);
    expect(results[1].index).toBe(1);
    expect(results[1].success).toBe(true);
  });

  it('throws when service is not initialized', () => {
    const origRepo = (ReputationService as any).repository;
    (ReputationService as any).repository = null;
    try {
      expect(() =>
        ReputationService.createBulkRatings([
          { reviewerId: 'r1', targetId: 't1', rating: 5, contextId: 'c1' },
        ])
      ).toThrow('ReputationService not initialized');
    } finally {
      (ReputationService as any).repository = origRepo;
    }
  });

  it('returns empty array for empty input', () => {
    const results = ReputationService.createBulkRatings([]);
    expect(results).toEqual([]);
  });
});
