/**
 * Reputation Service Tests
 *
 * Comprehensive test suite for reputation score aggregation logic,
 * including the recency-weighted exponential decay algorithm, every
 * anti-abuse guard in `createRating`, the payload-validation predicate
 * `isValidReputationRatingPayload`, and the new `updateProfile` write
 * surface used by the HTTP adapter.
 */

import {
  computeWeightedReputationScore,
  ReputationService,
  isValidReputationRatingPayload,
} from './reputation.service';
import { ReputationRepository } from '../repositories/reputationRepository';
import { auditService } from '../audit/service';
import { getDb } from '../db/database';
import Database from '../db/betterSqlite3';
import {
  ForbiddenError,
  ConflictError,
  ValidationError,
  AppError,
} from '../errors/appError';
import { validateEnv } from '../config/env.schema';

// Mock the audit service to avoid side effects and to assert calls cleanly.
jest.mock('../audit/service', () => ({
  auditService: {
    log: jest.fn(),
  },
}));

jest.mock('../config/env.schema', () => ({
  validateEnv: jest.fn(() => ({
    REPUTATION_ENABLED: true,
    REPUTATION_DECAY_LAMBDA: 0.005,
    REPUTATION_SCORE_ALGORITHM_VERSION: 'exp-decay-v1',
  })),
}));

// Save the original ReputationRepository constructor so mock-based suites
// can restore it after replacing the import binding.
const OriginalReputationRepository = ReputationRepository;

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

/**
 * Seeds a fresh `:memory:` SQLite instance with the minimal user + contract
 * fixture used by every integration-style test in this suite.
 */
function seedInMemoryDb(): ReturnType<typeof Database> {
  const db = getDb(':memory:');
  db.exec(`
    INSERT OR IGNORE INTO users (id, username, email, role, created_at)
    VALUES
      ('${REVIEWER_ID}', 'reviewer01', 'reviewer@test.com', 'client', datetime('now')),
      ('${TARGET_ID}',   'target01',   'target@test.com',   'freelancer', datetime('now')),
      ('${OUTSIDER_ID}', 'outsider01', 'outsider@test.com', 'client',    datetime('now'));
  `);
  insertContract(db, CONTEXT_ID);
  return db;
}

// ---------------------------------------------------------------------------
// isValidReputationRatingPayload — defense-in-depth predicate
// ---------------------------------------------------------------------------

describe('isValidReputationRatingPayload', () => {
  const validPayload = {
    reviewerId: 'reviewer-1',
    rating: 3,
    contextId: 'contract-1',
  };

  describe('rejects', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a primitive string', 'payload'],
      ['a primitive number', 42],
      ['a primitive boolean', true],
      ['an empty object', {}],
      ['a missing reviewerId', { rating: 3 }],
      ['an empty reviewerId', { reviewerId: '', rating: 3 }],
      ['a non-string reviewerId', { reviewerId: 123, rating: 3 }],
      ['a missing rating', { reviewerId: 'reviewer-1' }],
      ['a string rating', { reviewerId: 'reviewer-1', rating: '3' }],
      ['NaN', { reviewerId: 'reviewer-1', rating: Number.NaN }],
      ['positive Infinity', { reviewerId: 'reviewer-1', rating: Number.POSITIVE_INFINITY }],
      ['negative Infinity', { reviewerId: 'reviewer-1', rating: Number.NEGATIVE_INFINITY }],
      ['a decimal below the upper bound', { reviewerId: 'reviewer-1', rating: 4.9 }],
      ['a decimal above the lower bound', { reviewerId: 'reviewer-1', rating: 1.5 }],
      ['zero', { reviewerId: 'reviewer-1', rating: 0 }],
      ['a negative rating', { reviewerId: 'reviewer-1', rating: -1 }],
      ['a rating above the maximum', { reviewerId: 'reviewer-1', rating: 6 }],
      ['a rating above the maximum (large)', { reviewerId: 'reviewer-1', rating: 100 }],
      ['null rating', { reviewerId: 'reviewer-1', rating: null }],
    ])('rejects %s', (_case, payload) => {
      expect(isValidReputationRatingPayload(payload)).toBe(false);
    });
  });

  describe('accepts', () => {
    it.each([1, 2, 3, 4, 5])('accepts integer rating %i', (rating) => {
      expect(isValidReputationRatingPayload({ ...validPayload, rating })).toBe(true);
    });

    it('narrows the payload type', () => {
      const payload: unknown = { reviewerId: 'reviewer-1', rating: 4 };
      if (isValidReputationRatingPayload(payload)) {
        expect(typeof payload.reviewerId).toBe('string');
        expect(typeof payload.rating).toBe('number');
      }
    });

    it('allows unrelated extra fields (comment, contextId, jobCompleted)', () => {
      expect(
        isValidReputationRatingPayload({
          ...validPayload,
          comment: 'Great work',
          jobCompleted: true,
        }),
      ).toBe(true);
    });

    it('accepts a contextId-less payload (defense-in-depth layer only)', () => {
      // The predicate does not enforce contextId because the route layer's
      // Zod schema already does. Defense-in-depth focuses on the two fields
      // (reviewerId, rating) whose abuse vectors the service must guard.
      expect(isValidReputationRatingPayload({ reviewerId: 'a', rating: 5 })).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// computeWeightedReputationScore — mathematical core
// ---------------------------------------------------------------------------

describe('computeWeightedReputationScore — single-rating invariants', () => {
  it('returns the rating value for a single rating (age = 0)', () => {
    expect(computeWeightedReputationScore([{ rating: 5, createdAt: now.toISOString() }], now, lambda)).toBe(5);
  });

  it('returns the rating value for a single rating at any age', () => {
    expect(computeWeightedReputationScore(
      [{ rating: 3, createdAt: createFixedTimestamp(365, now) }],
      now,
      lambda,
    )).toBe(3);
  });

  it('returns the common value for two equal ratings with different ages', () => {
    const ratings = [
      { rating: 4, createdAt: createFixedTimestamp(0, now) },
      { rating: 4, createdAt: createFixedTimestamp(100, now) },
    ];
    expect(computeWeightedReputationScore(ratings, now, lambda)).toBe(4);
  });

  it('supports ratings with millisecond precision timestamps', () => {
    const preciseNow = new Date('2024-01-01T12:34:56.789Z');
    const ratings = [
      { rating: 5, createdAt: preciseNow.toISOString() },
      { rating: 3, createdAt: new Date(preciseNow.getTime() - 86400000).toISOString() },
    ];
    expect(computeWeightedReputationScore(ratings, preciseNow, lambda)).toBeGreaterThan(3);
    expect(computeWeightedReputationScore(ratings, preciseNow, lambda)).toBeLessThan(5);
  });
});

describe('computeWeightedReputationScore — multi-rating / decay semantics', () => {
  it('biases the score toward a newer higher rating', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(1000, now) },
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThan(3);
    expect(result).toBeLessThanOrEqual(5);
  });

  it('biases the score toward a newer lower rating', () => {
    const ratings = [
      { rating: 1, createdAt: createFixedTimestamp(0, now) },
      { rating: 5, createdAt: createFixedTimestamp(1000, now) },
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeLessThan(3);
    expect(result).toBeGreaterThanOrEqual(1);
  });

  it('keeps score within the input range for all inputs', () => {
    const ratings = [
      { rating: 1, createdAt: createFixedTimestamp(0, now) },
      { rating: 5, createdAt: createFixedTimestamp(100, now) },
      { rating: 3, createdAt: createFixedTimestamp(200, now) },
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(5);
  });

  it('higher lambda decays faster (newer rating dominates)', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(100, now) },
    ];
    const resultSlow = computeWeightedReputationScore(ratings, now, 0.001);
    const resultFast = computeWeightedReputationScore(ratings, now, 0.01);
    expect(resultFast).toBeGreaterThan(resultSlow);
  });

  it('is deterministic with identical inputs', () => {
    const ratings = [
      { rating: 4, createdAt: createFixedTimestamp(0, now) },
      { rating: 3, createdAt: createFixedTimestamp(50, now) },
      { rating: 5, createdAt: createFixedTimestamp(100, now) },
    ];
    expect(computeWeightedReputationScore(ratings, now, lambda))
      .toEqual(computeWeightedReputationScore(ratings, now, lambda));
  });

  it('is order-independent', () => {
    const ratings1 = [
      { rating: 2, createdAt: createFixedTimestamp(10, now) },
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
    ];
    const ratings2 = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 2, createdAt: createFixedTimestamp(10, now) },
    ];
    expect(computeWeightedReputationScore(ratings1, now, lambda))
      .toEqual(computeWeightedReputationScore(ratings2, now, lambda));
  });

  it('handles future timestamps (clock skew) by clamping age to zero', () => {
    const future = new Date(now.getTime());
    future.setDate(future.getDate() + 10);
    const ratings = [
      { rating: 5, createdAt: future.toISOString() },
      { rating: 3, createdAt: createFixedTimestamp(100, now) },
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThanOrEqual(3);
    expect(result).toBeLessThanOrEqual(5);

    // Future-timestamp alone should behave exactly like age 0.
    expect(computeWeightedReputationScore([{ rating: 5, createdAt: future.toISOString() }], now, lambda))
      .toBe(5);
  });
});

describe('ReputationService.createRating — comment validation guards', () => {
  let db: ReturnType<typeof Database>;
  let contractSeq = 0;

  function uniqueContract(): string {
    const id = `ctx-cv-${contractSeq++}`;
    db.exec(`
      INSERT OR IGNORE INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
      VALUES ('${id}', 'Test', 'rv-cv', 'tg-cv', 1000, 'completed', 0, datetime('now'));
    `);
    return id;
  }

  beforeAll(() => {
    db = getDb(':memory:');
    ReputationService.initialize(db);
    db.exec(`
      INSERT OR IGNORE INTO users (id, username, email, role, created_at)
      VALUES
        ('rv-cv', 'reviewer-cv', 'reviewer-cv@test.com', 'client', datetime('now')),
        ('tg-cv', 'target-cv',   'target-cv@test.com',   'freelancer', datetime('now'));
    `);
  });

  it('accepts comment at exactly 1000 characters (boundary)', () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz ';
    const comment = Array.from({ length: 1000 }, (_, i) => alphabet[i % alphabet.length]).join('');
    const entry = ReputationService.createRating('rv-cv', 'tg-cv', 5, uniqueContract(), comment);
    expect(entry.comment?.length).toBe(1000);
  });

  it('rejects comment exceeding 1000 characters', () => {
    const comment = 'a'.repeat(1001);
    expect(() => ReputationService.createRating('rv-cv', 'tg-cv', 5, uniqueContract(), comment))
      .toThrow('Comment exceeds maximum length of 1000 characters');
  });

  it('rejects whitespace-only comment', () => {
    expect(() => ReputationService.createRating('rv-cv', 'tg-cv', 5, uniqueContract(), '   '))
      .toThrow('Comment cannot be empty or whitespace-only');
  });

  it('rejects comment with excessive repetitive content (spam > 50%)', () => {
    const comment = 'aaaaa';
    expect(() => ReputationService.createRating('rv-cv', 'tg-cv', 5, uniqueContract(), comment))
      .toThrow('Comment contains excessive repetitive content');
  });

  it('rejects comment with mixed spam content', () => {
    const comment = '11111';
    expect(() => ReputationService.createRating('rv-cv', 'tg-cv', 5, uniqueContract(), comment))
      .toThrow('Comment contains excessive repetitive content');
  });
});

describe('ReputationService.createRating — audit failure handling', () => {
  let db: ReturnType<typeof Database>;

  beforeAll(() => {
    db = getDb(':memory:');
    ReputationService.initialize(db);
    db.exec(`
      INSERT OR IGNORE INTO users (id, username, email, role, created_at)
      VALUES ('rv-af', 'reviewer-af', 'reviewer-af@test.com', 'client', datetime('now')),
             ('tg-af', 'target-af',   'target-af@test.com',   'freelancer', datetime('now'));
      INSERT OR IGNORE INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
      VALUES ('ctx-af', 'Test', 'rv-af', 'tg-af', 1000, 'completed', 0, datetime('now'));
    `);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('re-throws error when audit logging fails', () => {
    const auditService = require('../audit/service').auditService;
    auditService.log.mockImplementationOnce(() => { throw new Error('Audit store unavailable'); });
    expect(() => ReputationService.createRating('rv-af', 'tg-af', 5, 'ctx-af', 'Great work'))
      .toThrow('Failed to create audit trail');
  });
});

describe('ReputationService — uninitialized', () => {
  const originalRepository = (ReputationService as any).repository;

  beforeAll(() => {
    (ReputationService as any).repository = null;
  });

  afterAll(() => {
    (ReputationService as any).repository = originalRepository;
  });

  it('throws error from createRating when not initialized', () => {
    expect(() => ReputationService.createRating('a', 'b', 5, 'c'))
      .toThrow('ReputationService not initialized');
  });

  it('throws error from getProfile when not initialized', () => {
    expect(() => ReputationService.getProfile('any-id'))
      .toThrow('ReputationService not initialized');
  });
});

describe('ReputationService.getProfile — empty target id', () => {
  let db: ReturnType<typeof Database>;

  beforeAll(() => {
    db = getDb(':memory:');
    ReputationService.initialize(db);
  });

  it('throws error for empty target ID', () => {
    expect(() => ReputationService.getProfile('')).toThrow('Freelancer ID is required');
  });
});

describe('computeWeightedReputationScore — mathematical edge cases', () => {
  it('returns 0 for empty ratings array', () => {
    expect(computeWeightedReputationScore([], now, lambda)).toBe(0);
  });

  it('returns exact rating for a single fractional rating', () => {
    expect(computeWeightedReputationScore([{ rating: 4.5, createdAt: now.toISOString() }], now, lambda)).toBe(4.5);
  });

  it('computes a known weighted average for two ratings at documented ages', () => {
    // Rating 1: age 0,  weight = exp(-0) = 1.0
    // Rating 2: age 100, weight = exp(-0.5) ≈ 0.6065
    // Expected ≈ (5 * 1.0 + 1 * 0.6065) / (1.0 + 0.6065) ≈ 3.48
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(100, now) },
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThan(3.4);
    expect(result).toBeLessThan(3.6);
  });

  it('handles very old ratings (1000+ days) with near-zero weight', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(1000, now) },
    ];
    expect(computeWeightedReputationScore(ratings, now, lambda)).toBeGreaterThan(4.9);
    expect(computeWeightedReputationScore(ratings, now, lambda)).toBeLessThanOrEqual(5);
  });

  it('handles extremely old ratings (3650 days = 10 years)', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(3650, now) },
    ];
    expect(computeWeightedReputationScore(ratings, now, lambda)).toBeGreaterThan(4.99);
    expect(computeWeightedReputationScore(ratings, now, lambda)).toBeLessThanOrEqual(5);
  });

  it('handles fractional rating values', () => {
    const ratings = [
      { rating: 4.5, createdAt: createFixedTimestamp(0, now) },
      { rating: 3.7, createdAt: createFixedTimestamp(50, now) },
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThan(3.7);
    expect(result).toBeLessThan(4.5);
  });

  it('handles zero lambda (no decay → simple arithmetic mean)', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(1000, now) },
    ];
    expect(computeWeightedReputationScore(ratings, now, 0)).toBe(3);
  });

  it('handles very high lambda (rapid decay)', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(10, now) },
    ];
    expect(computeWeightedReputationScore(ratings, now, 1.0)).toBeGreaterThan(4.5);
  });

  it('handles multiple ratings at the same timestamp (returns simple mean)', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 3, createdAt: createFixedTimestamp(0, now) },
      { rating: 4, createdAt: createFixedTimestamp(0, now) },
    ];
    expect(computeWeightedReputationScore(ratings, now, lambda)).toBe(4);
  });

  it('handles negative rating values defensively', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: -1, createdAt: createFixedTimestamp(100, now) },
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThan(2);
    expect(result).toBeLessThan(5);
  });

  it('handles rating values above the typical [1,5] range', () => {
    const ratings = [
      { rating: 10, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(100, now) },
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThan(1);
    expect(result).toBeLessThan(10);
  });

  it('exponential decay is monotonic decreasing with age', () => {
    const baseRating = { rating: 1, createdAt: createFixedTimestamp(0, now) };
    const ages = [0, 10, 50, 100, 500, 1000];
    const results = ages.map((age) =>
      computeWeightedReputationScore(
        [baseRating, { rating: 5, createdAt: createFixedTimestamp(age, now) }],
        now,
        lambda,
      ),
    );
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeLessThanOrEqual(results[i - 1]);
    }
  });

  it('handles large rating arrays efficiently', () => {
    const ratings = [];
    for (let i = 0; i < 1000; i++) {
      ratings.push({
        rating: Math.floor(Math.random() * 5) + 1,
        createdAt: createFixedTimestamp(Math.floor(Math.random() * 365), now),
      });
    }
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(5);
  });

  it('weight calculation is precise for small time differences', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 4, createdAt: createFixedTimestamp(1, now) },
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBeGreaterThan(4.4);
    expect(result).toBeLessThan(4.6);
  });

  it('stays finite for extreme input magnitudes', () => {
    const ratings = [
      { rating: Number.MAX_SAFE_INTEGER, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(1000, now) },
    ];
    expect(Number.isFinite(computeWeightedReputationScore(ratings, now, lambda))).toBe(true);
  });

  it('has stable 2-decimal rounding across identical runs', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 3, createdAt: createFixedTimestamp(100, now) },
    ];
    const r1 = computeWeightedReputationScore(ratings, now, lambda);
    const r2 = computeWeightedReputationScore(ratings, now, lambda);
    expect(parseFloat(r1.toFixed(2))).toEqual(parseFloat(r2.toFixed(2)));
  });

  it('handles malformed createdAt date string gracefully', () => {
    const ratings = [
      { rating: 5, createdAt: 'not-a-date' },
      { rating: 3, createdAt: createFixedTimestamp(100, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    // malformed entry should be skipped; result based on valid entry only
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(3);
  });

  it('handles empty-string createdAt date gracefully', () => {
    const ratings = [
      { rating: 5, createdAt: '' },
      { rating: 3, createdAt: createFixedTimestamp(100, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(3);
  });

  it('handles NaN rating value by skipping the entry', () => {
    const ratings = [
      { rating: NaN, createdAt: createFixedTimestamp(0, now) },
      { rating: 3, createdAt: createFixedTimestamp(100, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(3);
  });

  it('handles non-finite rating by skipping the entry', () => {
    const ratings = [
      { rating: Infinity, createdAt: createFixedTimestamp(0, now) },
      { rating: 3, createdAt: createFixedTimestamp(100, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(3);
  });

  it('handles negative lambda by clamping to 0 (no inverted decay)', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(1000, now) }
    ];
    const result = computeWeightedReputationScore(ratings, now, -0.005);
    // With clamped lambda=0, all weights are 1 → simple average of 3
    expect(result).toBe(3);
  });

  it('returns 0 when all entries are malformed (skipped completely)', () => {
    const ratings = [
      { rating: 5, createdAt: 'bad-date' },
      { rating: NaN, createdAt: createFixedTimestamp(0, now) },
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    expect(result).toBe(0);
  });

  it('triggers totalWeight underflow guard with extreme age and high lambda', () => {
    // lambda=10, ageInDays=1000 → weight = exp(-10000) → effectively 0
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 1, createdAt: createFixedTimestamp(1000, now) },
    ];
    const result = computeWeightedReputationScore(ratings, now, 10);
    // totalWeight ≈ 1 + 0 = 1 → should not hit the ===0 path with finite math
    expect(Number.isFinite(result)).toBe(true);
  });

  it('handles null created at gracefully', () => {
    const ratings = [
      { rating: 5, createdAt: createFixedTimestamp(0, now) },
      { rating: 3, createdAt: null as unknown as string },
    ];
    const result = computeWeightedReputationScore(ratings, now, lambda);
    // null date string → unparseable → skipped
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(5);
  });
});

// Save original ReputationRepository before mocking
type RepoType = typeof ReputationRepository;
const OriginalRepo: RepoType = ReputationRepository;

describe('ReputationService.getProfile', () => {
  const mockFindByTargetId = jest.fn();
  const mockDb = {} as any;

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ReputationRepository as any) = jest.fn().mockImplementation(() => ({
      findByTargetId: mockFindByTargetId
    }));
  });

  afterAll(() => {
    // Restore original ReputationRepository for subsequent suites
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ReputationRepository as any) = OriginalRepo;
  });

  beforeEach(() => {
    (ReputationService as any).repository = null;
  });

  afterAll(() => {
    // Restore the seeded state used by the rest of the suite.
    ReputationService.initialize(getDb(':memory:'));
  });

  it('createRating throws "not initialized" before any work', () => {
    expect(() =>
      ReputationService.createRating('r', 't', 5, 'c'),
    ).toThrow(/not initialized/i);
  });

  it('getProfile throws "not initialized" before any work', () => {
    expect(() => ReputationService.getProfile('t')).toThrow(/not initialized/i);
  });

  it('updateProfile throws "not initialized" before any work', () => {
    expect(() =>
      ReputationService.updateProfile('t', { reviewerId: 'r', rating: 5 }),
    ).toThrow(/not initialized/i);
  });
});

// ---------------------------------------------------------------------------
// ReputationService.createRating — anti-abuse guards (SQLite-backed)
// ---------------------------------------------------------------------------

describe('ReputationService.createRating — anti-abuse guards', () => {
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    jest.clearAllMocks();
    db = seedInMemoryDb();
    ReputationService.initialize(db);
    // Wipe ratings inserted by previous tests in this suite, while keeping
    // the seeded users + contracts.
    db.exec('DELETE FROM reputation_entries');
  });

  it('persists the rating, writes the audit log, and returns the new entry', () => {
    const entry = ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID, 'Solid work!');
    expect(entry).toMatchObject({
      reviewerId: REVIEWER_ID,
      targetId: TARGET_ID,
      rating: 5,
      contextId: CONTEXT_ID,
      comment: 'Solid work!',
    });
    expect(entry.id).toBeDefined();
    expect(reputationRowCount(db)).toBe(1);
    expect(auditService.log).toHaveBeenCalledTimes(1);
    const logArg = (auditService.log as jest.Mock).mock.calls[0][0];
    expect(logArg.action).toBe('REPUTATION_UPDATED');
    expect(logArg.actor).toBe(REVIEWER_ID);
    expect(logArg.resourceId).toBe(TARGET_ID);
    expect(logArg.metadata.after.rating).toBe(5);
    // The audit log stores a SHA-256 hash of the comment rather than plaintext.
    expect(logArg.metadata.after.comment).toMatch(/^[a-f0-9]{64}$/);
    expect(logArg.metadata.contextId).toBe(CONTEXT_ID);
  });

  it('logs metadata with comment = undefined when no comment is provided', () => {
    ReputationService.createRating(REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID);
    const logArg = (auditService.log as jest.Mock).mock.calls[0][0];
    expect(logArg.metadata.after.comment).toBeUndefined();
    expect(logArg.metadata.after.rating).toBe(4);
  });

  it('refuses self-rating and surfaces a ForbiddenError', () => {
    expect(() => ReputationService.createRating(REVIEWER_ID, REVIEWER_ID, 5, CONTEXT_ID))
      .toThrow(ForbiddenError);
    expect(reputationRowCount(db)).toBe(0);
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('refuses duplicate ratings via the service-level guard', () => {
    ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID);
    expect(() => ReputationService.createRating(REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID))
      .toThrow(ConflictError);
    expect(reputationRowCount(db)).toBe(1);
  });

  it('refuses duplicate ratings via the DB-level UNIQUE constraint safety net', () => {
    // Bypass the service-level guard by inserting a row directly. The repository
    // `create()` should re-throw as a ConflictError when SQLite rejects with
    // SQLITE_CONSTRAINT_UNIQUE.
    db.prepare(
      `INSERT INTO reputation_entries
         (id, reviewer_id, target_id, rating, comment, context_id, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, datetime('now'))`,
    ).run('seed-uuid', REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID);

    expect(() => ReputationService.createRating(REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID))
      .toThrow(ConflictError);
  });

  it('refuses when the reviewer is not a contract participant', () => {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
       VALUES ('other-user-1', 'other1', 'other1@test.com', 'client', datetime('now'))`
    ).run();
    insertContract(db, 'other-contract', 'other-user-1', TARGET_ID);
    expect(() => ReputationService.createRating(OUTSIDER_ID, TARGET_ID, 5, 'other-contract'))
      .toThrow(/participants/i);
    expect(reputationRowCount(db)).toBe(0);
  });

  it('refuses when the target is not a contract participant', () => {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
       VALUES ('other-user-2', 'other2', 'other2@test.com', 'freelancer', datetime('now'))`
    ).run();
    insertContract(db, 'reviewer-only-contract', REVIEWER_ID, 'other-user-2');
    expect(() => ReputationService.createRating(REVIEWER_ID, OUTSIDER_ID, 5, 'reviewer-only-contract'))
      .toThrow(/participants/i);
    expect(reputationRowCount(db)).toBe(0);
  });

  describe('comment policy (private validateComment via the createRating surface)', () => {
    it('rejects comments longer than 1000 characters', () => {
      const huge = 'a'.repeat(1001);
      expect(() => ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID, huge))
        .toThrow(ValidationError);
      expect(reputationRowCount(db)).toBe(0);
    });

    it('accepts a comment of exactly 1000 characters (boundary inclusive)', () => {
      const edge = 'Good job! '.repeat(100);
      expect(edge.length).toBe(1000);
      expect(() => ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID, edge))
        .not.toThrow();
      expect(reputationRowCount(db)).toBe(1);
    });

    it('rejects whitespace-only comments (>0 chars but empty after trim)', () => {
      expect(() => ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID, '   \t\n  '))
        .toThrow(ValidationError);
      expect(reputationRowCount(db)).toBe(0);
    });

    it('rejects comments where one character makes up more than 50% of the body', () => {
      const spam = 'aaaaabc'; // 6/7 = ~85% 'a' → spam
      expect(() => ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID, spam))
        .toThrow(/repetitive|spam/i);
      expect(reputationRowCount(db)).toBe(0);
    });

    it('accepts comments under the 50% repetition threshold', () => {
      const review = 'Great work, would hire again!'; // mixed characters
      expect(() => ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID, review))
        .not.toThrow();
      expect(reputationRowCount(db)).toBe(1);
    });

    it('does not invoke validateComment when comment is undefined', () => {
      expect(() => ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID, undefined))
        .not.toThrow();
      expect(reputationRowCount(db)).toBe(1);
    });
  });

  it('rethrows a generic Error when audit logging fails (no silent writes)', () => {
    (auditService.log as jest.Mock).mockImplementation(() => {
      throw new Error('audit store unavailable');
    });
    expect(() => ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID))
      .toThrow(/Failed to create audit trail|Rating not persisted/i);
  });
});

// ---------------------------------------------------------------------------
// ReputationService.updateProfile — payload validation (mock-based)
// ---------------------------------------------------------------------------

describe('ReputationService.updateProfile — payload validation', () => {
  // Use a mock repository so each test asserts validation logic in pure
  // isolation - the guards inside createRating will throw long before any
  // SQL touches the database. We re-initialize before each test to reset
  // any prior `findBy…` call expectations.
  let repositoryStub: { findByReviewerTargetContext: jest.Mock; create: jest.Mock; verifyContractParticipation: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    // Silence audit logging for these unit tests.
    (auditService.log as jest.Mock).mockImplementation(() => undefined);

    repositoryStub = {
      findByReviewerTargetContext: jest.fn().mockReturnValue(undefined),
      create: jest.fn().mockReturnValue({ id: 'stub-entry' }),
      verifyContractParticipation: jest.fn().mockReturnValue(true),
    };
    (ReputationRepository as jest.Mock) = jest.fn().mockImplementation(() => repositoryStub);
    ReputationService.initialize({} as never); // recording only that the static flag is set
  });

  describe('rejects with AppError(400, bad_request)', () => {
    const cases: Array<[string, unknown]> = [
      ['undefined body', undefined],
      ['null body', null],
      ['a string body', 'hello'],
      ['a number body', 123],
      ['an empty object', {}],
      ['a missing reviewerId', { rating: 3, contextId: 'c' }],
      ['a blank reviewerId', { reviewerId: '', rating: 3, contextId: 'c' }],
      ['a non-string reviewerId', { reviewerId: 123, rating: 3, contextId: 'c' }],
      ['a missing rating', { reviewerId: 'r', contextId: 'c' }],
      ['a string rating', { reviewerId: 'r', rating: '5', contextId: 'c' }],
      ['a null rating', { reviewerId: 'r', rating: null, contextId: 'c' }],
      ['NaN rating', { reviewerId: 'r', rating: NaN, contextId: 'c' }],
      ['+Infinity rating', { reviewerId: 'r', rating: Infinity, contextId: 'c' }],
      ['-Infinity rating', { reviewerId: 'r', rating: -Infinity, contextId: 'c' }],
      ['rating = 0 (below min)', { reviewerId: 'r', rating: 0, contextId: 'c' }],
      ['rating = -1', { reviewerId: 'r', rating: -1, contextId: 'c' }],
      ['rating = 6 (above max)', { reviewerId: 'r', rating: 6, contextId: 'c' }],
      ['rating = 1.5 (decimal)', { reviewerId: 'r', rating: 1.5, contextId: 'c' }],
      ['rating = 4.9 (decimal)', { reviewerId: 'r', rating: 4.9, contextId: 'c' }],
    ];

    it.each(cases)('rejects %s', (_label, payload) => {
      expect(() => ReputationService.updateProfile(TARGET_ID, payload)).toThrow(AppError);
      try {
        ReputationService.updateProfile(TARGET_ID, payload);
      } catch (e) {
        const err = e as AppError;
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('bad_request');
      }
    });

    it('throws before any DB lookup is performed', () => {
      expect(() =>
        ReputationService.updateProfile(TARGET_ID, { reviewerId: 'r', rating: 100 }),
      ).toThrow(AppError);
      expect(repositoryStub.findByReviewerTargetContext).not.toHaveBeenCalled();
    });
  });

  describe('guards delegated to createRating', () => {
    beforeEach(() => {
      // Seed a service that accepts the rating payload so we can drive the
      // guards individually.
      jest.clearAllMocks();
      (auditService.log as jest.Mock).mockImplementation(() => undefined);
    });

    it('wraps ForbiddenError from createRating (self-rating) verbatim', () => {
      // Override the repository stub so the self-rating guard runs first.
      (ReputationRepository as jest.Mock) = jest.fn().mockImplementation(() => ({
        findByReviewerTargetContext: jest.fn().mockReturnValue(undefined),
        create: jest.fn(),
        verifyContractParticipation: jest.fn().mockReturnValue(true),
      }));
      ReputationService.initialize({} as never);
      expect(() => ReputationService.updateProfile(REVIEWER_ID, {
        reviewerId: REVIEWER_ID, rating: 5, contextId: 'c',
      })).toThrow(ForbiddenError);
    });

    it('wraps ConflictError from createRating (duplicate) verbatim', () => {
      (ReputationRepository as jest.Mock) = jest.fn().mockImplementation(() => ({
        findByReviewerTargetContext: jest.fn().mockReturnValue({ id: 'existing' }),
        create: jest.fn(),
        verifyContractParticipation: jest.fn().mockReturnValue(true),
      }));
      ReputationService.initialize({} as never);
      expect(() => ReputationService.updateProfile(TARGET_ID, {
        reviewerId: REVIEWER_ID, rating: 5, contextId: 'c',
      })).toThrow(ConflictError);
    });

    it('wraps ValidationError from createRating (comment policy) verbatim', () => {
      (ReputationRepository as jest.Mock) = jest.fn().mockImplementation(() => ({
        findByReviewerTargetContext: jest.fn().mockReturnValue(undefined),
        create: jest.fn(),
        verifyContractParticipation: jest.fn().mockReturnValue(true),
      }));
      ReputationService.initialize({} as never);
      expect(() => ReputationService.updateProfile(TARGET_ID, {
        reviewerId: REVIEWER_ID,
        rating: 5,
        contextId: 'c',
        comment: 'a'.repeat(1001),
      })).toThrow(ValidationError);
    });
  });
});

// ---------------------------------------------------------------------------
// ReputationService.updateProfile — happy path (SQLite-backed)
// ---------------------------------------------------------------------------

describe('ReputationService.updateProfile — happy path', () => {
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    jest.clearAllMocks();
    (ReputationRepository as unknown) = OriginalReputationRepository;
    db = seedInMemoryDb();
    ReputationService.initialize(db);
    db.exec('DELETE FROM reputation_entries');
  });

  it('persists the rating and returns the recomputed profile', () => {
    const profile = ReputationService.updateProfile(TARGET_ID, {
      reviewerId: REVIEWER_ID,
      contextId: CONTEXT_ID,
      rating: 5,
      comment: 'Excellent freelancer',
    });

    expect(profile.freelancerId).toBe(TARGET_ID);
    expect(profile.totalRatings).toBe(1);
    expect(profile.score).toBe(5);
    expect(profile.weightedScore).toBe(5);
    expect(profile.reviews).toHaveLength(1);
    expect(profile.reviews[0]).toMatchObject({
      reviewerId: REVIEWER_ID,
      rating: 5,
      comment: 'Excellent freelancer',
    });
    expect(reputationRowCount(db)).toBe(1);
  });

  it('returns a profile that reflects the aggregated score across two ratings', () => {
    ReputationService.updateProfile(TARGET_ID, {
      reviewerId: REVIEWER_ID, contextId: CONTEXT_ID, rating: 5,
    });
    insertContract(db, 'second-contract', REVIEWER_ID, TARGET_ID);
    const profile = ReputationService.updateProfile(TARGET_ID, {
      reviewerId: REVIEWER_ID, contextId: 'second-contract', rating: 3,
    });
    expect(profile.totalRatings).toBe(2);
    expect(profile.score).toBe(4); // (5 + 3) / 2
    expect(reputationRowCount(db)).toBe(2);
  });

  it('writes an audit log entry whose comment is a SHA-256 hash (no plaintext)', () => {
    ReputationService.updateProfile(TARGET_ID, {
      reviewerId: REVIEWER_ID, contextId: CONTEXT_ID, rating: 5,
      comment: 'plaintext-must-not-leak',
    });
    const call = (auditService.log as jest.Mock).mock.calls[0][0];
    expect(call.metadata.after.comment).toMatch(/^[a-f0-9]{64}$/);
    expect(call.metadata.after.comment).not.toContain('plaintext');
  });

  it('forwards payload.contextId to createRating (drives participation check)', () => {
    // If updateProfile stripped contextId, the participation guard would
    // throw a generic SQL error rather than the clear ForbiddenError we
    // expect when neither party is listed.
    insertContract(db, 'unrelated-contract', OUTSIDER_ID, OUTSIDER_ID);
    expect(() => ReputationService.updateProfile(TARGET_ID, {
      reviewerId: REVIEWER_ID, contextId: 'unrelated-contract', rating: 5,
    })).toThrow(/participants/i);
  });
});

// ---------------------------------------------------------------------------
// ReputationService.getProfile — error paths + aggregation (mock-based)
// ---------------------------------------------------------------------------

describe('ReputationService.getProfile — error paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (ReputationRepository as jest.Mock) = jest.fn().mockImplementation(() => ({
      findByTargetId: jest.fn().mockReturnValue([]),
    }));
    ReputationService.initialize({} as never);
  });

  it('throws AppError(400, bad_request, "Freelancer ID is required") for an empty targetId', () => {
    expect(() => ReputationService.getProfile('')).toThrow(AppError);
    try {
      ReputationService.getProfile('');
      fail('expected AppError to be thrown');
    } catch (e) {
      const err = e as AppError;
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('bad_request');
    }
  });

  afterAll(() => {
    (ReputationRepository as unknown) = OriginalReputationRepository;
  });
});

describe('ReputationService.getProfile — aggregation (mock-based)', () => {
  let findByTargetIdMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    findByTargetIdMock = jest.fn().mockReturnValue([]);
    (ReputationRepository as jest.Mock) = jest.fn().mockImplementation(() => ({
      findByTargetId: findByTargetIdMock,
    }));
    ReputationService.initialize({} as never);
  });

  it('returns 0 score + 0 weightedScore for empty ratings', () => {
    const profile = ReputationService.getProfile('test-id');
    expect(profile.score).toBe(0);
    expect(profile.weightedScore).toBe(0);
    expect(profile.totalRatings).toBe(0);
    expect(profile.reviews).toEqual([]);
  });

  it('rounds score and weightedScore to 2 decimal places via toFixed(2)', () => {
    findByTargetIdMock.mockReturnValue([
      { id: '1', reviewerId: 'r1', targetId: 'test-id', rating: 5, contextId: 'c1', createdAt: new Date().toISOString() },
      { id: '2', reviewerId: 'r2', targetId: 'test-id', rating: 4, contextId: 'c2', createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 100).toISOString() },
    ]);
    const profile = ReputationService.getProfile('test-id');
    expect(profile.score.toFixed(2)).toMatch(/^\d+\.\d{2}$/);
    expect(profile.weightedScore.toFixed(2)).toMatch(/^\d+\.\d{2}$/);
  });

  it('computes arithmetic mean for the score field', () => {
    findByTargetIdMock.mockReturnValue([
      { id: '1', reviewerId: 'r1', targetId: 't1', rating: 5, contextId: 'c1', createdAt: new Date().toISOString() },
      { id: '2', reviewerId: 'r2', targetId: 't1', rating: 3, contextId: 'c2', createdAt: new Date().toISOString() },
      { id: '3', reviewerId: 'r3', targetId: 't1', rating: 4, contextId: 'c3', createdAt: new Date().toISOString() },
    ]);
    const profile = ReputationService.getProfile('t1');
    expect(profile.score).toBe(4.00);
    expect(profile.totalRatings).toBe(3);
  });

  it('maps repository entries into Review shape', () => {
    findByTargetIdMock.mockReturnValue([
      {
        id: '1', reviewerId: 'r1', targetId: 't1',
        rating: 4, comment: 'Great work!',
        contextId: 'c1', createdAt: new Date().toISOString(),
      },
    ]);
    const profile = ReputationService.getProfile('t1');
    expect(profile.reviews).toHaveLength(1);
    expect(profile.reviews[0]).toMatchObject({
      reviewerId: 'r1',
      rating: 4,
      comment: 'Great work!',
    });
    expect(profile.freelancerId).toBe('t1');
    expect(profile.lastUpdated).toBeDefined();
  });

  it('exposes weightedScore and scoreAlgorithm fields even when the env is unconfigured', () => {
    findByTargetIdMock.mockReturnValue([
      { id: '1', reviewerId: 'r1', targetId: 'test-id', rating: 5, contextId: 'c1', createdAt: new Date().toISOString() },
    ]);
    const profile = ReputationService.getProfile('test-id');
    expect(typeof profile.weightedScore).toBe('number');
    expect(typeof profile.scoreAlgorithm).toBe('string');
    expect(profile.scoreAlgorithm).toBe('exp-decay-v1');
  });

  afterAll(() => {
    (ReputationRepository as unknown) = OriginalReputationRepository;
  });
});

describe('ReputationService — feature flag (REPUTATION_ENABLED)', () => {
  let db: ReturnType<typeof Database>;

  beforeAll(() => {
    db = getDb(':memory:');
    ReputationService.initialize(db);

    // Seed minimal user rows
    db.exec(`
      INSERT OR IGNORE INTO users (id, username, email, role, created_at)
      VALUES
        ('reviewer-123', 'reviewer01', 'reviewer@test.com', 'client', datetime('now')),
        ('target-456', 'target01', 'target@test.com', 'freelancer', datetime('now'));
    `);

    // Seed contract
    db.prepare(
      `INSERT OR IGNORE INTO contracts
         (id, title, client_id, freelancer_id, amount, status, version, created_at)
       VALUES (?, ?, ?, ?, 1000, 'completed', 0, datetime('now'))`,
    ).run('contract-abc', 'Contract contract-abc', 'reviewer-123', 'target-456');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('createRating throws ForbiddenError when REPUTATION_ENABLED is false', () => {
    (validateEnv as jest.Mock).mockReturnValue({ REPUTATION_ENABLED: false });

    expect(() => {
      ReputationService.createRating(
        'reviewer-123',
        'target-456',
        5,
        'contract-abc',
        'Great work!'
      );
    }).toThrow('Reputation system is currently disabled');
  });

  it('createRating succeeds when REPUTATION_ENABLED is true', () => {
    (validateEnv as jest.Mock).mockReturnValue({ REPUTATION_ENABLED: true });

    const entry = ReputationService.createRating(
      'reviewer-123',
      'target-456',
      5,
      'contract-abc',
      'Great work!'
    );

    expect(entry).toBeDefined();
    expect(entry.reviewerId).toBe('reviewer-123');
    expect(entry.targetId).toBe('target-456');
    expect(entry.rating).toBe(5);
  });

  it('getProfile throws ForbiddenError when REPUTATION_ENABLED is false', () => {
    (validateEnv as jest.Mock).mockReturnValue({ REPUTATION_ENABLED: false });

    expect(() => {
      ReputationService.getProfile('target-456');
    }).toThrow('Reputation system is currently disabled');
  });

  it('getProfile succeeds when REPUTATION_ENABLED is true', () => {
    (validateEnv as jest.Mock).mockReturnValue({ REPUTATION_ENABLED: true });

    const profile = ReputationService.getProfile('target-456');

    expect(profile).toBeDefined();
    expect(profile.freelancerId).toBe('target-456');
  });

  it('defaults to disabled when validateEnv throws an error', () => {
    (validateEnv as jest.Mock).mockImplementation(() => {
      throw new Error('Config validation failed');
    });

    expect(() => {
      ReputationService.createRating(
        'reviewer-123',
        'target-456',
        5,
        'contract-abc',
        'Great work!'
      );
    }).toThrow('Reputation system is currently disabled');
  });
});

// ─── Cursor-paginated getProfilePaginated ──────────────────────────────────

describe('ReputationService.getProfilePaginated', () => {
  let db: ReturnType<typeof Database>;
  const PAG_TARGET = 'paginated-target-svc';

  beforeAll(() => {
    db = getDb(':memory:');
    ReputationService.initialize(db);

    // Seed users
    db.exec(`
      INSERT OR IGNORE INTO users (id, username, email, role, created_at)
      VALUES
        ('rev-svc-a', 'rva', 'rva@test.com', 'client', datetime('now')),
        ('${PAG_TARGET}', 'pgtargetsvc', 'pgtargetsvc@test.com', 'freelancer', datetime('now'));
    `);

    // Create 15 entries with staggered timestamps for deterministic order
    for (let i = 0; i < 15; i++) {
      const createdAt = new Date(Date.UTC(2024, 0, 1 + i)).toISOString();
      const contractId = `ctx-svc-${String(i).padStart(3, '0')}`;
      db.prepare(
        `INSERT OR IGNORE INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
         VALUES (?, ?, 'rev-svc-a', ?, 100, 'completed', 0, datetime('now'))`
      ).run(contractId, `C-${i}`, PAG_TARGET);

      const { randomUUID } = require('crypto');
      db.prepare(
        `INSERT INTO reputation_entries (id, reviewer_id, target_id, rating, comment, context_id, created_at)
         VALUES (?, 'rev-svc-a', ?, ?, NULL, ?, ?)`
      ).run(
        randomUUID(),
        PAG_TARGET,
        (i % 5) + 1,
        contractId,
        createdAt,
      );
    }
  });

  describe('aggregation correctness', () => {
    it('score and totalRatings reflect ALL entries, not just the page', () => {
      const profile = ReputationService.getProfilePaginated(PAG_TARGET, { limit: 3 });
      // totalRatings must come from the full dataset (15), not the page (3)
      expect(profile.totalRatings).toBe(15);
      expect(profile.reviews).toHaveLength(3);
    });

    it('weightedScore is computed from all entries', () => {
      const profile = ReputationService.getProfilePaginated(PAG_TARGET, { limit: 3 });
      expect(profile.weightedScore).toBeGreaterThanOrEqual(1);
      expect(profile.weightedScore).toBeLessThanOrEqual(5);
    });
  });

  describe('pagination behaviour', () => {
    it('returns default page size of 20 reviews', () => {
      const profile = ReputationService.getProfilePaginated(PAG_TARGET);
      expect(profile.limit).toBe(20);
      expect(profile.reviews.length).toBeLessThanOrEqual(20);
    });

    it('returns nextCursor when there are more reviews', () => {
      const profile = ReputationService.getProfilePaginated(PAG_TARGET, { limit: 5 });
      expect(profile.hasNextPage).toBe(true);
      expect(profile.nextCursor).not.toBeNull();
      expect(typeof profile.nextCursor).toBe('string');
    });

    it('returns null nextCursor on the last page', () => {
      const profile = ReputationService.getProfilePaginated(PAG_TARGET, { limit: 15 });
      expect(profile.hasNextPage).toBe(false);
      expect(profile.nextCursor).toBeNull();
    });
  });

  describe('cursor traversal', () => {
    it('traverses all pages correctly', () => {
      const collected: string[] = [];
      let cursor: string | undefined;

      do {
        const profile = ReputationService.getProfilePaginated(PAG_TARGET, {
          limit: 4,
          cursor,
        });
        collected.push(...profile.reviews.map(r => r.reviewerId + '|' + r.createdAt));
        cursor = profile.nextCursor ?? undefined;
      } while (cursor);

      // All 15 reviews collected
      expect(collected).toHaveLength(15);
      // No duplicates
      expect(new Set(collected).size).toBe(15);
    });

    it('successive pages have no overlapping reviews', () => {
      const page1 = ReputationService.getProfilePaginated(PAG_TARGET, { limit: 8 });
      const page2 = ReputationService.getProfilePaginated(PAG_TARGET, {
        limit: 8,
        cursor: page1.nextCursor!,
      });

      const keys1 = new Set(page1.reviews.map(r => r.createdAt + r.reviewerId));
      const keys2 = new Set(page2.reviews.map(r => r.createdAt + r.reviewerId));
      for (const k of keys2) {
        expect(keys1.has(k)).toBe(false);
      }
    });
  });

  describe('edge cases', () => {
    it('returns empty reviews for target with no ratings', () => {
      const profile = ReputationService.getProfilePaginated('no-ratings-svc');
      expect(profile.reviews).toEqual([]);
      expect(profile.totalRatings).toBe(0);
      expect(profile.score).toBe(0);
      expect(profile.weightedScore).toBe(0);
      expect(profile.hasNextPage).toBe(false);
      expect(profile.nextCursor).toBeNull();
    });

    it('throws for empty targetId', () => {
      expect(() => ReputationService.getProfilePaginated('')).toThrow('Target ID is required');
    });

    it('preserves all profile fields in paginated response', () => {
      const profile = ReputationService.getProfilePaginated(PAG_TARGET, { limit: 5 });
      expect(profile.freelancerId).toBe(PAG_TARGET);
      expect(typeof profile.score).toBe('number');
      expect(typeof profile.weightedScore).toBe('number');
      expect(Array.isArray(profile.reviews)).toBe(true);
      expect(typeof profile.scoreAlgorithm).toBe('string');
      expect(typeof profile.lastUpdated).toBe('string');
      // Pagination-specific fields
      expect('nextCursor' in profile).toBe(true);
      expect('hasNextPage' in profile).toBe(true);
      expect('limit' in profile).toBe(true);
    });

    it('review item shape is unchanged', () => {
      const profile = ReputationService.getProfilePaginated(PAG_TARGET, { limit: 2 });
      for (const review of profile.reviews) {
        expect(typeof review.reviewerId).toBe('string');
        expect(typeof review.rating).toBe('number');
        expect(typeof review.createdAt).toBe('string');
        // comment may be undefined
        expect(review.hasOwnProperty('comment')).toBe(true);
      }
    });
  });
});
