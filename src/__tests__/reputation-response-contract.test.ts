import request from 'supertest';
import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { getDb } from '../db/database';
import { ReputationService } from '../services/reputation.service';
import { ReputationRepository } from '../repositories/reputationRepository';
import { ForbiddenError, ConflictError, ValidationError } from '../errors/appError';
import { ReputationController } from '../controllers/reputation.controller';
import reputationRoutes from '../routes/reputation.routes';

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.JWT_SECRET = TEST_SECRET;

const adminToken = jwt.sign(
  { sub: 'admin-1', email: 'admin@tt.com', role: 'admin' },
  TEST_SECRET,
  { expiresIn: '1h' },
);

// ---------------------------------------------------------------------------
// Contract keys — tests fail on unexpected extra or missing fields
// ---------------------------------------------------------------------------

const SUCCESS_ENVELOPE_KEYS = ['status', 'data', 'correlationId'] as const;

const PROFILE_KEYS = [
  'freelancerId',
  'score',
  'jobsCompleted',
  'totalRatings',
  'reviews',
  'lastUpdated',
  'weightedScore',
  'scoreAlgorithm',
] as const;

const REVIEW_KEYS = ['reviewerId', 'rating', 'comment', 'createdAt'] as const;

const REVIEW_KEYS_NO_COMMENT = ['reviewerId', 'rating', 'createdAt'] as const;

const ERROR_ENVELOPE_KEYS = ['error'] as const;

const ERROR_BODY_KEYS = ['code', 'message', 'requestId', 'correlationId'] as const;

const VALIDATION_ERROR_DETAIL_KEYS = ['path', 'message', 'code'] as const;

const STATUS_ERROR_KEYS = ['status', 'message'] as const;

const mockNext = jest.fn();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectExactKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  const actual = Object.keys(obj).sort();
  const expected = [...allowed].sort();
  expect(actual).toEqual(expected);
}

// ---------------------------------------------------------------------------
// Global setup — in-memory DB, seed users & contracts
// ---------------------------------------------------------------------------

let db: ReturnType<typeof getDb>;
let repo: ReputationRepository;
const reviewerId = randomUUID();
const targetA = randomUUID();
const targetB = randomUUID();
const contractAB = randomUUID();
const contractBB = randomUUID();

beforeAll(() => {
  db = getDb(':memory:');
  ReputationService.initialize(db);
  repo = new ReputationRepository(db);

  db.exec(`
    INSERT OR IGNORE INTO users (id, username, email, role, created_at)
    VALUES
      ('${reviewerId}', 'ct_reviewer', 'ct_r@test.com', 'client', datetime('now')),
      ('${targetA}',    'ct_target_a', 'ct_a@test.com', 'freelancer', datetime('now')),
      ('${targetB}',    'ct_target_b', 'ct_b@test.com', 'freelancer', datetime('now'));
  `);

  db.exec(`
    INSERT OR IGNORE INTO contracts
      (id, title, client_id, freelancer_id, amount, status, version, created_at)
    VALUES
      ('${contractAB}', 'Contract AB', '${reviewerId}', '${targetA}', 1000, 'completed', 0, datetime('now')),
      ('${contractBB}', 'Contract BB', '${reviewerId}', '${targetB}', 1000, 'completed', 0, datetime('now'));
  `);
});

// ---------------------------------------------------------------------------
// Suite 1 — GET profile response contract (empty profile)
// ---------------------------------------------------------------------------

describe('Reputation response contract — GET /:id empty profile', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/reputation', reputationRoutes);
  });

  it('success envelope has exactly { status, data }', async () => {
    const res = await request(app)
      .get(`/api/v1/reputation/${targetA}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expectExactKeys(res.body, [...SUCCESS_ENVELOPE_KEYS]);
    expect(res.body.status).toBe('success');
  });

  it('profile data has exactly the documented 8 fields', async () => {
    const res = await request(app)
      .get(`/api/v1/reputation/${targetA}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expectExactKeys(res.body.data, [...PROFILE_KEYS]);
  });

  it('profile fields have correct types (empty profile)', async () => {
    const res = await request(app)
      .get(`/api/v1/reputation/${targetA}`)
      .set('Authorization', `Bearer ${adminToken}`);

    const d = res.body.data;
    expect(typeof d.freelancerId).toBe('string');
    expect(typeof d.score).toBe('number');
    expect(typeof d.jobsCompleted).toBe('number');
    expect(typeof d.totalRatings).toBe('number');
    expect(Array.isArray(d.reviews)).toBe(true);
    expect(typeof d.lastUpdated).toBe('string');
    expect(typeof d.weightedScore).toBe('number');
    expect(typeof d.scoreAlgorithm).toBe('string');
  });

  it('empty profile returns zero-valued metrics and empty reviews', async () => {
    const res = await request(app)
      .get(`/api/v1/reputation/${targetA}`)
      .set('Authorization', `Bearer ${adminToken}`);

    const d = res.body.data;
    expect(d.score).toBe(0);
    expect(d.totalRatings).toBe(0);
    expect(d.reviews).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — GET profile with reviews (seeded via repository)
// ---------------------------------------------------------------------------

describe('Reputation response contract — GET /:id with reviews', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/reputation', reputationRoutes);

    repo.create({
      reviewerId,
      targetId: targetB,
      rating: 5,
      comment: 'Excellent work!',
      contextId: contractBB,
    });
  });

  it('review item has exactly { reviewerId, rating, comment, createdAt } when comment present', async () => {
    const res = await request(app)
      .get(`/api/v1/reputation/${targetB}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.reviews.length).toBeGreaterThanOrEqual(1);

    const review = res.body.data.reviews[0];
    expectExactKeys(review, [...REVIEW_KEYS]);
  });

  it('review item types are correct', async () => {
    const res = await request(app)
      .get(`/api/v1/reputation/${targetB}`)
      .set('Authorization', `Bearer ${adminToken}`);

    const review = res.body.data.reviews[0];
    expect(typeof review.reviewerId).toBe('string');
    expect(typeof review.rating).toBe('number');
    expect(typeof review.comment).toBe('string');
    expect(typeof review.createdAt).toBe('string');
  });

  it('review rating is within [1, 5]', async () => {
    const res = await request(app)
      .get(`/api/v1/reputation/${targetB}`)
      .set('Authorization', `Bearer ${adminToken}`);

    const review = res.body.data.reviews[0];
    expect(review.rating).toBeGreaterThanOrEqual(1);
    expect(review.rating).toBeLessThanOrEqual(5);
  });

  it('review createdAt is a valid ISO 8601 string', async () => {
    const res = await request(app)
      .get(`/api/v1/reputation/${targetB}`)
      .set('Authorization', `Bearer ${adminToken}`);

    const review = res.body.data.reviews[0];
    const parsed = new Date(review.createdAt);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });

  it('profile score is numeric and within [0, 5]', async () => {
    const res = await request(app)
      .get(`/api/v1/reputation/${targetB}`)
      .set('Authorization', `Bearer ${adminToken}`);

    const d = res.body.data;
    expect(typeof d.score).toBe('number');
    expect(d.score).toBeGreaterThanOrEqual(0);
    expect(d.score).toBeLessThanOrEqual(5);
  });

  it('scoreAlgorithm is a non-empty string', async () => {
    const res = await request(app)
      .get(`/api/v1/reputation/${targetB}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(typeof res.body.data.scoreAlgorithm).toBe('string');
    expect(res.body.data.scoreAlgorithm.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — GET profile without comment (optional field absent)
// ---------------------------------------------------------------------------

describe('Reputation response contract — review without comment', () => {
  let app: express.Application;
  const noCommentTarget = randomUUID();
  const noCommentContract = randomUUID();

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/reputation', reputationRoutes);

    db.exec(`
      INSERT OR IGNORE INTO users (id, username, email, role, created_at)
      VALUES ('${noCommentTarget}', 'nc_target', 'nc_target@test.com', 'freelancer', datetime('now'));
    `);
    db.exec(`
      INSERT OR IGNORE INTO contracts
        (id, title, client_id, freelancer_id, amount, status, version, created_at)
      VALUES ('${noCommentContract}', 'Contract NC', '${reviewerId}', '${noCommentTarget}', 500, 'completed', 0, datetime('now'));
    `);

    repo.create({
      reviewerId,
      targetId: noCommentTarget,
      rating: 3,
      contextId: noCommentContract,
    });
  });

  it('review item omits comment field when not provided', async () => {
    const res = await request(app)
      .get(`/api/v1/reputation/${noCommentTarget}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.reviews.length).toBe(1);
    const review = res.body.data.reviews[0];
    expectExactKeys(review, [...REVIEW_KEYS_NO_COMMENT]);
    expect(review).not.toHaveProperty('comment');
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — PUT rating success response envelope
// ---------------------------------------------------------------------------

describe('Reputation response contract — PUT /:id success envelope', () => {
  let app: express.Application;
  const putTarget = randomUUID();
  const putContract = randomUUID();

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/reputation', reputationRoutes);

    db.exec(`
      INSERT OR IGNORE INTO users (id, username, email, role, created_at)
      VALUES ('${putTarget}', 'put_target', 'put_target@test.com', 'freelancer', datetime('now'));
    `);
    db.exec(`
      INSERT OR IGNORE INTO contracts
        (id, title, client_id, freelancer_id, amount, status, version, created_at)
      VALUES ('${putContract}', 'Contract PUT', '${reviewerId}', '${putTarget}', 500, 'completed', 0, datetime('now'));
    `);
  });

  beforeEach(() => {
    db.exec('DELETE FROM reputation_entries');
  });

  it('PUT success returns envelope with exactly { status, data }', async () => {
    const res = await request(app)
      .put(`/api/v1/reputation/${putTarget}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        reviewerId,
        rating: 4,
        comment: 'Great!',
        contextId: putContract,
      });

    expect(res.status).toBe(200);
    expectExactKeys(res.body, [...SUCCESS_ENVELOPE_KEYS]);
    expect(res.body.status).toBe('success');
  });

  it('PUT success data has the full profile shape', async () => {
    const res = await request(app)
      .put(`/api/v1/reputation/${putTarget}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        reviewerId,
        rating: 4,
        comment: 'Great!',
        contextId: putContract,
      });

    expectExactKeys(res.body.data, [...PROFILE_KEYS]);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Error response contracts (via supertest)
// ---------------------------------------------------------------------------

describe('Reputation response contract — error envelopes', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/reputation', reputationRoutes);
  });

  describe('400 — validation middleware error (ZodError)', () => {
    it('returns { error: { code, message, requestId, details[] } }', async () => {
      const res = await request(app)
        .put(`/api/v1/reputation/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'r1', rating: 10 });

      expect(res.status).toBe(400);
      expectExactKeys(res.body, [...ERROR_ENVELOPE_KEYS]);
      expectExactKeys(res.body.error, [...ERROR_BODY_KEYS, 'details']);
      expect(res.body.error.code).toBe('validation_error');
      expect(typeof res.body.error.message).toBe('string');
      expect(typeof res.body.error.requestId).toBe('string');
      expect(Array.isArray(res.body.error.details)).toBe(true);
      expect(res.body.error.details.length).toBeGreaterThan(0);

      const detail = res.body.error.details[0];
      expectExactKeys(detail, [...VALIDATION_ERROR_DETAIL_KEYS]);
      expect(Array.isArray(detail.path)).toBe(true);
      expect(typeof detail.message).toBe('string');
      expect(typeof detail.code).toBe('string');
    });
  });

  describe('400 — missing required fields', () => {
    it('rejects empty body', async () => {
      const res = await request(app)
        .put(`/api/v1/reputation/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      expect(Array.isArray(res.body.error.details)).toBe(true);
    });

    it('rejects missing contextId', async () => {
      const res = await request(app)
        .put(`/api/v1/reputation/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'r1', rating: 3 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });

    it('rejects invalid UUID for contextId', async () => {
      const res = await request(app)
        .put(`/api/v1/reputation/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'r1', rating: 3, contextId: 'not-a-uuid' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });
  });

  describe('400 — invalid rating types', () => {
    it('rejects decimal rating', async () => {
      const res = await request(app)
        .put(`/api/v1/reputation/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'r1', rating: 3.5, contextId: randomUUID() });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });

    it('rejects string rating', async () => {
      const res = await request(app)
        .put(`/api/v1/reputation/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'r1', rating: '3', contextId: randomUUID() });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });
  });

  describe('400 — spam comment rejected by Zod', () => {
    it('rejects repetitive comment at Zod level', async () => {
      const spamComment = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const res = await request(app)
        .put(`/api/v1/reputation/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'r1', rating: 3, comment: spamComment, contextId: randomUUID() });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — Controller-level error shapes (service-layer errors via mocks)
// ---------------------------------------------------------------------------

describe('Reputation response contract — controller error shapes', () => {
  beforeEach(() => jest.clearAllMocks());

  function makeRes() {
    const jsonMock = jest.fn();
    const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    const res = {
      status: statusMock,
      locals: {
        requestId: 'contract-test-req-id',
        correlationId: 'contract-test-corr-id',
      },
    } as unknown as Response;
    return { res, statusMock, jsonMock };
  }

  describe('getProfile — 500 unknown error', () => {
    it('returns { error: { code, message, requestId } } with no extra fields', async () => {
      jest.spyOn(ReputationService, 'getProfile').mockImplementation(() => {
        throw new Error('Database down');
      });

      const { res, statusMock, jsonMock } = makeRes();
      await ReputationController.getProfile(
        { params: { id: 'x' } } as unknown as Request,
        res
      );

      expect(statusMock).toHaveBeenCalledWith(500);
      const body = jsonMock.mock.calls[0][0];
      expectExactKeys(body, [...ERROR_ENVELOPE_KEYS]);
      expectExactKeys(body.error, [...ERROR_BODY_KEYS]);
      expect(body.error.code).toBe('internal_error');
      expect(body.error.message).toBe('An unexpected error occurred');
      expect(body.error.requestId).toBe('contract-test-req-id');

      jest.restoreAllMocks();
    });
  });

  describe('getProfile — 400 bad request', () => {
    it('returns { error: { code, message, requestId } } with no extra fields', async () => {
      jest.spyOn(ReputationService, 'getProfile').mockImplementation(() => {
        throw new Error('Freelancer ID is required');
      });

      const { res, statusMock, jsonMock } = makeRes();
      await ReputationController.getProfile(
        { params: { id: '' } } as unknown as Request,
        res
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      const body = jsonMock.mock.calls[0][0];
      expectExactKeys(body, [...ERROR_ENVELOPE_KEYS]);
      expectExactKeys(body.error, [...ERROR_BODY_KEYS]);
      expect(body.error.code).toBe('bad_request');
      expect(body.error.requestId).toBe('contract-test-req-id');

      jest.restoreAllMocks();
    });
  });

  describe('createRating — 400 invalid payload', () => {
    it('returns { error: { code, message, requestId } } with no extra fields', async () => {
      const { res, statusMock, jsonMock } = makeRes();
      await ReputationController.createRating(
        {
          params: { id: 'x' },
          body: { rating: 'invalid' },
        } as unknown as Request,
        res
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      const body = jsonMock.mock.calls[0][0];
      expectExactKeys(body, [...ERROR_ENVELOPE_KEYS]);
      expectExactKeys(body.error, [...ERROR_BODY_KEYS]);
      expect(body.error.code).toBe('bad_request');
    });
  });

  describe('createRating — 403 ForbiddenError', () => {
    it('returns { error: { code, message, requestId } } with no extra fields', async () => {
      jest.spyOn(ReputationService as any, 'updateProfile').mockImplementation(() => {
        throw new ForbiddenError('Users cannot rate themselves');
      });

      const { res, statusMock, jsonMock } = makeRes();
      await ReputationController.createRating(
        {
          params: { id: 'x' },
          body: { reviewerId: 'r1', rating: 3, contextId: 'ctx' },
        } as unknown as Request,
        res
      );

      expect(statusMock).toHaveBeenCalledWith(403);
      const body = jsonMock.mock.calls[0][0];
      expectExactKeys(body, [...ERROR_ENVELOPE_KEYS]);
      expectExactKeys(body.error, [...ERROR_BODY_KEYS]);
      expect(body.error.code).toBe('forbidden');
      expect(body.error.message).toBe('Users cannot rate themselves');

      jest.restoreAllMocks();
    });
  });

  describe('createRating — 409 ConflictError', () => {
    it('returns { error: { code, message, requestId } } with no extra fields', async () => {
      jest.spyOn(ReputationService as any, 'updateProfile').mockImplementation(() => {
        throw new ConflictError('Rating already exists');
      });

      const { res, statusMock, jsonMock } = makeRes();
      await ReputationController.createRating(
        {
          params: { id: 'x' },
          body: { reviewerId: 'r1', rating: 3, contextId: 'ctx' },
        } as unknown as Request,
        res
      );

      expect(statusMock).toHaveBeenCalledWith(409);
      const body = jsonMock.mock.calls[0][0];
      expectExactKeys(body, [...ERROR_ENVELOPE_KEYS]);
      expectExactKeys(body.error, [...ERROR_BODY_KEYS]);
      expect(body.error.code).toBe('conflict');
      expect(body.error.message).toBe('Rating already exists');

      jest.restoreAllMocks();
    });
  });

  describe('createRating — 422 ValidationError', () => {
    it('returns { error: { code, message, requestId } } with no extra fields', async () => {
      jest.spyOn(ReputationService as any, 'updateProfile').mockImplementation(() => {
        throw new ValidationError('Comment contains spam');
      });

      const { res, statusMock, jsonMock } = makeRes();
      await ReputationController.createRating(
        {
          params: { id: 'x' },
          body: { reviewerId: 'r1', rating: 3, contextId: 'ctx' },
        } as unknown as Request,
        res
      );

      expect(statusMock).toHaveBeenCalledWith(422);
      const body = jsonMock.mock.calls[0][0];
      expectExactKeys(body, [...ERROR_ENVELOPE_KEYS]);
      expectExactKeys(body.error, [...ERROR_BODY_KEYS]);
      expect(body.error.code).toBe('validation_error');
      expect(body.error.message).toBe('Comment contains spam');

      jest.restoreAllMocks();
    });
  });

  describe('createRating — 500 unknown error', () => {
    it('returns { error: { code, message, requestId } } with no extra fields', async () => {
      jest.spyOn(ReputationService as any, 'updateProfile').mockImplementation(() => {
        throw new Error('Unexpected failure');
      });

      const { res, statusMock, jsonMock } = makeRes();
      await ReputationController.createRating(
        {
          params: { id: 'x' },
          body: { reviewerId: 'r1', rating: 3, contextId: 'ctx' },
        } as unknown as Request,
        res
      );

      expect(statusMock).toHaveBeenCalledWith(500);
      const body = jsonMock.mock.calls[0][0];
      expectExactKeys(body, [...ERROR_ENVELOPE_KEYS]);
      expectExactKeys(body.error, [...ERROR_BODY_KEYS]);
      expect(body.error.code).toBe('internal_error');
      expect(body.error.message).toBe('An unexpected error occurred');

      jest.restoreAllMocks();
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — No response leaks internal details
// ---------------------------------------------------------------------------

describe('Reputation response contract — no information leakage', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/reputation', reputationRoutes);
  });

  it('error responses never contain stack traces', async () => {
    const res = await request(app)
      .put(`/api/v1/reputation/${randomUUID()}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reviewerId: 'r1', rating: 10 });

    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toMatch(/stack/i);
    expect(bodyStr).not.toMatch(/at\s+\w+\.\w+\s*\(/);
    expect(bodyStr).not.toMatch(/node_modules/);
  });

  it('success responses never contain error fields', async () => {
    const res = await request(app)
      .get(`/api/v1/reputation/${targetA}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('error');
    expect(res.body).not.toHaveProperty('stack');
  });
});
