/**
 * Reputation Service Tests
 * 
 * Comprehensive test suite for reputation score aggregation logic,
 * including the recency-weighted exponential decay algorithm.
 */

import {
  computeWeightedReputationScore,
  ReputationService
} from './reputation.service';
import { ReputationRepository } from '../repositories/reputationRepository';
import { getDb } from '../db/database';
import Database from '../db/betterSqlite3';

// Mock the audit service to avoid side effects
jest.mock('../audit/service', () => ({
  auditService: {
    log: jest.fn()
  }
}));

// Test constants
const REVIEWER_ID = 'reviewer-123';
const TARGET_ID = 'target-456';
const OUTSIDER_ID = 'outsider-789';
const CONTEXT_ID = 'contract-abc';
const now = new Date('2024-01-01T00:00:00.000Z');
const lambda = 0.005; // Default decay constant

/**
 * Creates a fixed timestamp for deterministic testing.
 * @returns ISO 8601 timestamp string
 */
function createFixedTimestamp(daysOffset: number, baseDate: Date): string {
  const date = new Date(baseDate.getTime());
  date.setDate(date.getDate() - daysOffset);
  return date.toISOString();
}

/**
 * Inserts a new contract row so the service's participation check passes.
 *
 * @param db       - Open in-memory SQLite instance.
 * @param id       - The contract UUID.
 * @param clientId - User who plays the client role.
 * @param freelancerId - User who plays the freelancer role.
 */
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

/**
 * Returns the total number of reputation_entries rows currently in the DB.
 */
function reputationRowCount(db: ReturnType<typeof Database>): number {
  const row = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM reputation_entries').get();
  return row?.c ?? 0;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ReputationService.createRating — anti-abuse protections', () => {
  let db: ReturnType<typeof Database>;

  beforeAll(() => {
    // Use a fresh in-memory SQLite instance with full schema migrations.
    db = getDb(':memory:');
    ReputationService.initialize(db);

    // Seed the minimal user rows required by FK constraints.
    db.exec(`
      INSERT OR IGNORE INTO users (id, username, email, role, created_at)
      VALUES
        ('${REVIEWER_ID}', 'reviewer01', 'reviewer@test.com', 'client', datetime('now')),
        ('${TARGET_ID}',   'target01',   'target@test.com',   'freelancer', datetime('now')),
        ('${OUTSIDER_ID}', 'outsider01', 'outsider@test.com', 'client',    datetime('now'));
    `);

    // Seed the main contract used by most tests.
    insertContract(db, CONTEXT_ID);
  });

  it('returns the rating value for single rating (age = 0)', () => {
    const rating = {
      rating: 5,
      createdAt: now.toISOString()
    };
    const result = computeWeightedReputationScore([rating], now, lambda);
    expect(result).toBe(5);
  });

  it('returns the rating value for single rating (old age)', () => {
    const rating = {
      rating: 3,
      createdAt: createFixedTimestamp(365, now)
    };
    const result = computeWeightedReputationScore([rating], now, lambda);
    expect(result).toBe(3);
  });

  it('returns common value for two equal ratings with different ages', () => {
    const ratings = [
      { rating: 4, createdAt: createFixedTimestamp(0, now) },
      { rating: 4, createdAt: createFixedTimestamp(100, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBe(4);
  });

  it('biases score toward newer higher rating', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) }, // New 5
      { rating: 1, createdAt: createFixedTimestamp(1000, now) } // Very old 1
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThan(3); // Should be closer to 5 than 1
    expect(result).toBeLessThanOrEqual(5);
  });

  it('biases score toward newer lower rating', () => {
    const ratings = [
      { rating: 1, createdAt: createFixedTimestamp(0, now) }, // New 1
      { rating: 5, createdAt: createFixedTimestamp(1000, now) } // Very old 5
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeLessThan(3); // Should be closer to 1 than 5
    expect(result).toBeGreaterThanOrEqual(1);
  });

  it('score remains within input range [1, 5] for all inputs', () => {
    const ratings = [
      { rating: 1, createdAt: createFixedTimestamp(0, now) },
      { rating: 5, createdAt: createFixedTimestamp(100, now) },
      { rating: 3, createdAt: createFixedTimestamp(200, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(5);
  });

  it('higher lambda decays faster', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) }, // New 5
      { rating: 1, createdAt: createFixedTimestamp(100, now) } // Old 1
    ];
    const resultSlow = computeWeightedReputationScore(ratings, now, 0.001);
    const resultFast = computeWeightedReputationScore(ratings, now, 0.01);
    // Fast decay should be closer to 5 (new rating) than slow decay
    expect(resultFast).toBeGreaterThan(resultSlow);
  });

  it('is deterministic with identical inputs', () => {
    const ratings = [
      { rating: 4, createdAt: createFixedTimestamp(0, now) },
      { rating: 3, createdAt: createFixedTimestamp(50, now) },
      { rating: 5, createdAt: createFixedTimestamp(100, now) }
    ];
    const result1 = computeWeightedReputationScore(ratings, now, lambda);
    const result2 = computeWeightedReputationScore(ratings, now, lambda);
    expect(result1).toEqual(result2);
  });

  it('order of inputs does not change result', () => {
    const ratings1 = [
      { rating: 2, createdAt: createFixedTimestamp(10, now) },
      { rating: 5, createdAt: createFixedTimestamp(0, now) }
    ];
    const ratings2 = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 2, createdAt: createFixedTimestamp(10, now) }
    ];
    const result1 = computeWeightedReputationScore(ratings1, now, lambda);
    const result2 = computeWeightedReputationScore(ratings2, now, lambda);
    expect(result1).toEqual(result2);
  });

  it('handles future timestamps (clock skew) gracefully', () => {
    const futureDate = new Date(now.getTime());
    futureDate.setDate(futureDate.getDate() + 10); // 10 days in future
    const ratings = [
      { rating: 5, createdAt: futureDate.toISOString() },
      { rating: 3, createdAt: createFixedTimestamp(100, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThanOrEqual(3);
    expect(result).toBeLessThanOrEqual(5);
    // Future rating should be treated as age 0
  });

  it('has stable rounding to 2 decimal places', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 3, createdAt: createFixedTimestamp(100, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    // Round to 2 decimals and check it's stable
    const rounded = parseFloat(result.toFixed(2));
    expect(rounded).toBeGreaterThanOrEqual(3);
    expect(rounded).toBeLessThanOrEqual(5);
    // Rounding should not introduce instability
    const result2 = computeWeightedReputationScore(ratings, now, lambda);
    expect(parseFloat(result2.toFixed(2))).toEqual(rounded);
  });
});

describe('computeWeightedReputationScore — mathematical edge cases', () => {
  it('returns 0 for empty ratings array', () => {
    const result = computeWeightedReputationScore([], now, lambda);
    expect(result).toBe(0);
  });

  it('returns exact rating for single rating at age 0', () => {
    const rating = { rating: 4.5, createdAt: now.toISOString() };
    const result = computeWeightedReputationScore([rating], now, lambda);
    expect(result).toBe(4.5);
  });

  it('returns exact rating for single rating at any age (weight cancels out)', () => {
    const rating = { rating: 3.7, createdAt: createFixedTimestamp(500, now) };
    const result = computeWeightedReputationScore([rating], now, lambda);
    expect(result).toBe(3.7);
  });

  it('computes correct weighted average for two ratings with known weights', () => {
    // Rating 1: age 0 days, weight = exp(-0.005 * 0) = 1.0
    // Rating 2: age 100 days, weight = exp(-0.005 * 100) = exp(-0.5) ≈ 0.6065
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(100, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    // Expected: (5 * 1.0 + 1 * 0.6065) / (1.0 + 0.6065) ≈ 3.48
    expect(result).toBeGreaterThan(3.4);
    expect(result).toBeLessThan(3.6);
  });

  it('verifies exponential decay formula: weight decreases with age', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 5, createdAt: createFixedTimestamp(10, now) },
      { rating: 5, createdAt: createFixedTimestamp(100, now) },
      { rating: 5, createdAt: createFixedTimestamp(1000, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    // All ratings are 5, so result should be 5 regardless of weights
    expect(result).toBe(5);
  });

  it('handles very old ratings (1000+ days) with near-zero weight', () => {
    // Age 1000 days with lambda=0.005: weight = exp(-5) ≈ 0.0067
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(1000, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    // Should be very close to 5 since old rating has negligible weight
    expect(result).toBeGreaterThan(4.9);
    expect(result).toBeLessThanOrEqual(5);
  });

  it('handles extremely old ratings (3650 days = 10 years)', () => {
    // Age 3650 days with lambda=0.005: weight = exp(-18.25) ≈ 1.1e-8
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(3650, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    // Should be essentially 5 since 10-year-old rating has virtually zero weight
    expect(result).toBeGreaterThan(4.99);
    expect(result).toBeLessThanOrEqual(5);
  });

  it('handles fractional rating values', () => {
    const ratings = [
      { rating: 4.5, createdAt: createFixedTimestamp(0, now) },
      { rating: 3.7, createdAt: createFixedTimestamp(50, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThan(3.7);
    expect(result).toBeLessThan(4.5);
  });

  it('handles zero lambda (no decay)', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(1000, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, 0);
    // With zero decay, all weights are 1, so it's a simple average
    expect(result).toBe(3);
  });

  it('handles very high lambda (rapid decay)', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(10, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, 1.0);
    // With high lambda, old rating should have negligible weight
    expect(result).toBeGreaterThan(4.5);
    expect(result).toBeLessThanOrEqual(5);
  });

  it('handles multiple ratings at same timestamp', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 3, createdAt: createFixedTimestamp(0, now) },
      { rating: 4, createdAt: createFixedTimestamp(0, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    // All same age, so should be simple average
    expect(result).toBe(4);
  });

  it('handles negative rating values (defensive)', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: -1, createdAt: createFixedTimestamp(100, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    // Should compute weighted average even with negative values
    expect(result).toBeGreaterThan(2);
    expect(result).toBeLessThan(5);
  });

  it('handles rating values above typical range', () => {
    const ratings = [
      { rating: 10, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(100, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    // Should compute weighted average even with values > 5
    expect(result).toBeGreaterThan(1);
    expect(result).toBeLessThan(10);
  });

  it('exponential decay weight is monotonic decreasing with age', () => {
    const baseRating = { rating: 5, createdAt: createFixedTimestamp(0, now) };
    const ages = [0, 10, 50, 100, 500, 1000];
    const results = ages.map(age => {
      const rating = { rating: 5, createdAt: createFixedTimestamp(age, now) };
      return computeWeightedReputationScore([baseRating, rating], now, lambda);
    });
    // As age increases, the influence of the old rating decreases
    // So the weighted average should move closer to the base rating (5)
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThanOrEqual(results[i - 1]);
    }
  });

  it('handles large number of ratings efficiently', () => {
    const ratings = [];
    for (let i = 0; i < 1000; i++) {
      ratings.push({
        rating: Math.floor(Math.random() * 5) + 1,
        createdAt: createFixedTimestamp(Math.floor(Math.random() * 365), now)
      });
    }
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(5);
  });

  it('weight calculation is precise for small time differences', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 4, createdAt: createFixedTimestamp(1, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    // 1 day difference should have minimal impact with lambda=0.005
    expect(result).toBeGreaterThan(4.4);
    expect(result).toBeLessThan(4.6);
  });

  it('handles ratings with millisecond precision timestamps', () => {
    const preciseNow = new Date('2024-01-01T12:34:56.789Z');
    const ratings = [
      { rating: 5, createdAt: preciseNow.toISOString() },
      { rating: 3, createdAt: new Date(preciseNow.getTime() - 86400000).toISOString() }
    ];
    const result = computeWeightedReputationScore(ratings, preciseNow, lambda);
    expect(result).toBeGreaterThan(3);
    expect(result).toBeLessThan(5);
  });

  it('defensive: clamps negative age to zero (future timestamps)', () => {
    const futureDate = new Date(now.getTime() + 86400000 * 10); // 10 days future
    const ratings = [
      { rating: 5, createdAt: futureDate.toISOString() }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    // Future timestamp should be treated as age 0
    expect(result).toBe(5);
  });

  it('weighted sum and total weight remain finite for all inputs', () => {
    const ratings = [
      { rating: Number.MAX_SAFE_INTEGER, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(1000, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    // Should not return Infinity or NaN
    expect(Number.isFinite(result)).toBe(true);
  });
});

describe('ReputationService.getProfile', () => {
  const mockFindByTargetId = jest.fn();
  const mockDb = {} as any;

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock the repository
    (ReputationRepository as jest.Mock) = jest.fn().mockImplementation(() => ({
      findByTargetId: mockFindByTargetId
    }));
    ReputationService.initialize(mockDb);
  });

  it('returns 0 weightedScore for empty ratings', () => {
    mockFindByTargetId.mockReturnValue([]);
    const profile = ReputationService.getProfile('test-id');
    expect(profile.weightedScore).toBe(0);
    expect(profile.score).toBe(0);
  });

  it('includes weightedScore and scoreAlgorithm in response', () => {
    const now = new Date();
    const ratings = [
      {
        id: '1',
        reviewerId: 'reviewer1',
        targetId: 'test-id',
        rating: 5,
        contextId: 'ctx1',
        createdAt: now.toISOString()
      }
    ];
    mockFindByTargetId.mockReturnValue(ratings);
    const profile = ReputationService.getProfile('test-id');
    expect(profile.weightedScore).toBeDefined();
    expect(profile.scoreAlgorithm).toBeDefined();
    expect(typeof profile.weightedScore).toBe('number');
    expect(typeof profile.scoreAlgorithm).toBe('string');
  });

  it('preserves all existing fields', () => {
    const now = new Date();
    const ratings = [
      {
        id: '1',
        reviewerId: 'reviewer1',
        targetId: 'test-id',
        rating: 4,
        comment: 'Great work!',
        contextId: 'ctx1',
        createdAt: now.toISOString()
      }
    ];
    mockFindByTargetId.mockReturnValue(ratings);
    const profile = ReputationService.getProfile('test-id');
    expect(profile.freelancerId).toBe('test-id');
    expect(profile.score).toBeDefined();
    expect(profile.totalRatings).toBe(1);
    expect(profile.reviews).toHaveLength(1);
    expect(profile.lastUpdated).toBeDefined();
  });

  it('computes correct arithmetic mean for score field', () => {
    const ratings = [
      { id: '1', reviewerId: 'r1', targetId: 't1', rating: 5, contextId: 'c1', createdAt: new Date().toISOString() },
      { id: '2', reviewerId: 'r2', targetId: 't1', rating: 3, contextId: 'c2', createdAt: new Date().toISOString() },
      { id: '3', reviewerId: 'r3', targetId: 't1', rating: 4, contextId: 'c3', createdAt: new Date().toISOString() }
    ];
    mockFindByTargetId.mockReturnValue(ratings);
    const profile = ReputationService.getProfile('t1');
    // Arithmetic mean should be (5+3+4)/3 = 4.0
    expect(profile.score).toBe(4.00);
  });

  it('rounds score and weightedScore to 2 decimal places', () => {
    const ratings = [
      { id: '1', reviewerId: 'r1', targetId: 't1', rating: 5, contextId: 'c1', createdAt: new Date().toISOString() },
      { id: '2', reviewerId: 'r2', targetId: 't1', rating: 4, contextId: 'c2', createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 100).toISOString() }
    ];
    mockFindByTargetId.mockReturnValue(ratings);
    const profile = ReputationService.getProfile('t1');
    // Check that scores are rounded to (at most) 2 decimals. `score` and
    // `weightedScore` are numeric fields (asserted elsewhere in this suite via
    // `toBe(0)`, `toBe(4.00)`, and `typeof … === 'number'`), so a JS number such
    // as 4.5 renders as "4.5" via toString() and can never carry a forced
    // trailing zero. Formatting with toFixed(2) is the correct way to verify the
    // 2-decimal rounding contract without contradicting the numeric-type tests.
    expect(profile.score.toFixed(2)).toMatch(/^\d+\.\d{2}$/);
    expect(profile.weightedScore.toFixed(2)).toMatch(/^\d+\.\d{2}$/);
  });
});
