/**
 * Integration tests for PATCH /api/v1/contracts/:id (OCC versioning)
 *
 * Builds a minimal Express app with the real validation middleware and error
 * handler, but uses a mock ContractsService to avoid the native better-sqlite3
 * dependency in the test environment.
 *
 * Requirements: 2.1, 2.2, 3.1, 3.2, 3.3, 3.4, 5.1, 5.2, 5.4
 */

import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { validateUpdateContract } from '../modules/contracts/validation.middleware';
import { AppError, VersionConflictError } from '../errors/appError';
import { UpdateContractDto } from '../modules/contracts/dto/contract.dto';
import { Contract } from '../db/types';

// ── Minimal mock service ──────────────────────────────────────────────────────

type UpdateFn = (id: string, dto: UpdateContractDto) => Promise<Contract>;

/** Builds a minimal Express app wired with the real middleware + a mock service. */
function createTestApp(updateContract: UpdateFn): express.Application {
  const app = express();
  app.use(express.json());

  const router = Router();

  router.patch(
    '/:id',
    validateUpdateContract,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const contract = await updateContract(
          req.params.id,
          req.body as UpdateContractDto,
        );
        res.status(200).json({ status: 'success', data: contract });
      } catch (err) {
        next(err);
      }
    },
  );

  app.use('/api/v1/contracts', router);

  // Global error handler — mirrors src/app.ts
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
        },
      });
    }
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}

/** A sample contract returned on successful update. */
function makeContract(id: string, version: number): Contract {
  return {
    id,
    title: 'Test Contract Title',
    clientId: 'client-1',
    freelancerId: 'freelancer-1',
    amount: 1000,
    status: 'draft',
    version,
    createdAt: new Date().toISOString(),
  };
}

const CONTRACT_ID = 'test-contract-uuid-1234';

// ── Test suite ────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/contracts/:id — OCC integration', () => {
  // ── Requirement 2.1: missing version → 400 ERR_MISSING_VERSION ─────────────

  describe('version field validation', () => {
    // For validation tests the service is never reached — use a no-op
    const app = createTestApp(async () => {
      throw new Error('should not be called');
    });

    it('returns 400 ERR_MISSING_VERSION when version is absent', async () => {
      const res = await request(app)
        .patch(`/api/v1/contracts/${CONTRACT_ID}`)
        .send({ title: 'Updated Title Here' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ERR_MISSING_VERSION');
    });

    it('returns 400 ERR_MISSING_VERSION when body is empty', async () => {
      const res = await request(app)
        .patch(`/api/v1/contracts/${CONTRACT_ID}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ERR_MISSING_VERSION');
    });

    // ── Requirement 2.2: invalid version → 400 ERR_INVALID_VERSION ───────────

    it('returns 400 ERR_INVALID_VERSION when version is -1', async () => {
      const res = await request(app)
        .patch(`/api/v1/contracts/${CONTRACT_ID}`)
        .send({ version: -1, title: 'Updated Title Here' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ERR_INVALID_VERSION');
    });

    it('returns 400 ERR_INVALID_VERSION when version is 1.5 (float)', async () => {
      const res = await request(app)
        .patch(`/api/v1/contracts/${CONTRACT_ID}`)
        .send({ version: 1.5, title: 'Updated Title Here' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ERR_INVALID_VERSION');
    });

    it('returns 400 ERR_INVALID_VERSION when version is a string', async () => {
      const res = await request(app)
        .patch(`/api/v1/contracts/${CONTRACT_ID}`)
        .send({ version: 'abc', title: 'Updated Title Here' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ERR_INVALID_VERSION');
    });

    it('returns 400 ERR_INVALID_VERSION when version is null', async () => {
      const res = await request(app)
        .patch(`/api/v1/contracts/${CONTRACT_ID}`)
        .send({ version: null, title: 'Updated Title Here' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ERR_INVALID_VERSION');
    });
  });

  // ── Requirement 3.2 / 5.1 / 5.2 / 5.4: stale version → 409 ERR_CONFLICT ──

  describe('version conflict (stale version)', () => {
    // Service always throws VersionConflictError (simulates stale version)
    const app = createTestApp(async () => {
      throw new VersionConflictError();
    });

    it('returns 409 ERR_CONFLICT when version is stale', async () => {
      const res = await request(app)
        .patch(`/api/v1/contracts/${CONTRACT_ID}`)
        .send({ version: 99, title: 'Updated Title Here' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ERR_CONFLICT');
    });

    it('conflict response body contains only error fields (no contract data)', async () => {
      const res = await request(app)
        .patch(`/api/v1/contracts/${CONTRACT_ID}`)
        .send({ version: 99, title: 'Updated Title Here' });

      expect(res.status).toBe(409);
      // Must have correct error shape
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('ERR_CONFLICT');
      expect(res.body.error.message).toBe('Version conflict');
      // Must NOT contain contract fields
      expect(res.body.id).toBeUndefined();
      expect(res.body.title).toBeUndefined();
      expect(res.body.status).toBeUndefined();
      expect(res.body.version).toBeUndefined();
      expect(res.body.data).toBeUndefined();
    });
  });

  // ── Requirement 3.1 / 3.4: correct version → 200 with incremented version ──

  describe('successful update', () => {
    it('returns 200 with incremented version on correct version', async () => {
      // Service returns contract with version = supplied + 1
      const app = createTestApp(async (_id, dto) => {
        return makeContract(CONTRACT_ID, dto.version + 1);
      });

      const res = await request(app)
        .patch(`/api/v1/contracts/${CONTRACT_ID}`)
        .send({ version: 0, title: 'Updated Title Here' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.version).toBe(1);
      expect(res.body.data.id).toBe(CONTRACT_ID);
    });

    it('response includes all contract fields on success', async () => {
      const app = createTestApp(async (_id, dto) => {
        return makeContract(CONTRACT_ID, dto.version + 1);
      });

      const res = await request(app)
        .patch(`/api/v1/contracts/${CONTRACT_ID}`)
        .send({ version: 0, title: 'Updated Title Here' });

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.id).toBeDefined();
      expect(data.title).toBeDefined();
      expect(data.version).toBe(1);
      expect(data.status).toBeDefined();
    });

    it('version 0 is accepted as a valid version', async () => {
      const app = createTestApp(async (_id, dto) => {
        return makeContract(CONTRACT_ID, dto.version + 1);
      });

      const res = await request(app)
        .patch(`/api/v1/contracts/${CONTRACT_ID}`)
        .send({ version: 0 });

      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(1);
    });
  });

  // ── Requirement 3.3: concurrent updates — exactly one 200, one 409 ─────────

  describe('concurrent updates', () => {
    it('concurrent updates with same version: exactly one 200 and one 409', async () => {
      // Simulate the real OCC behavior: first call succeeds, second throws conflict
      let callCount = 0;
      const app = createTestApp(async (_id, dto) => {
        callCount++;
        if (callCount === 1) {
          // Simulate a small delay so both requests are "in flight"
          await new Promise((resolve) => setTimeout(resolve, 5));
          return makeContract(CONTRACT_ID, dto.version + 1);
        }
        // Second concurrent call gets a conflict
        throw new VersionConflictError();
      });

      const [res1, res2] = await Promise.all([
        request(app)
          .patch(`/api/v1/contracts/${CONTRACT_ID}`)
          .send({ version: 0, title: 'Concurrent Update One' }),
        request(app)
          .patch(`/api/v1/contracts/${CONTRACT_ID}`)
          .send({ version: 0, title: 'Concurrent Update Two' }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);

      // The 409 must carry ERR_CONFLICT
      const conflictRes = res1.status === 409 ? res1 : res2;
      expect(conflictRes.body.error.code).toBe('ERR_CONFLICT');

      // The 200 must carry version = 1
      const successRes = res1.status === 200 ? res1 : res2;
      expect(successRes.body.data.version).toBe(1);
    });
  });
});
