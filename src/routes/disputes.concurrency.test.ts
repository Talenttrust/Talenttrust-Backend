/**
 * @file disputes.concurrency.test.ts
 * @description Concurrency smoke tests for disputes endpoint and service.
 *
 * These tests fire concurrent requests to uncover race conditions and ensure
 * no lost updates occur under concurrent load. Tests are deterministic and bounded
 * (no real network calls) to provide fast, reliable feedback.
 *
 * Strategy
 * ────────
 * - Test concurrent service operations (in-memory Map store)
 * - Test concurrent HTTP requests to disputes endpoints
 * - Assert no lost updates and consistent state
 * - Test read-after-write consistency under load
 * - Test batch operations under concurrency
 *
 * Coverage targets (≥ 95 %):
 *   - Concurrent writes produce correct count with no lost updates
 *   - State transitions remain valid under concurrent updates
 *   - Read operations see consistent state during writes
 *   - Batch operations handle concurrent requests correctly
 *   - HTTP endpoints handle concurrent requests safely
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { DisputesService, DisputeError } from '../services/disputes.service';
import { DisputeStatus } from '../modules/disputes/dto/dispute.dto';
import { createDisputesRouter } from './disputes.routes';
import { requestIdMiddleware } from '../middleware/requestId';

// ── Mock auth middleware ─────────────────────────────────────────────────────
jest.mock('../middleware/authorization', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// ── Mock feature flags ───────────────────────────────────────────────────────
let mockDisputesEnabled = true;
jest.mock('../config/features', () => ({
  features: {
    get disputesEnabled() { return mockDisputesEnabled; },
  },
}));

// ── Mock escrow hooks ───────────────────────────────────────────────────────
jest.mock('../hooks/escrow.hooks', () => ({
  EscrowHooks: {
    onStateTransition: jest.fn().mockResolvedValue(null),
  },
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function createTestDisputeInput(index: number) {
  return {
    contractId: `contract-${index}`,
    reason: `Test dispute ${index}`,
    raisedBy: `user-${index}`,
  };
}

function createTestUpdatePayload(status?: DisputeStatus, resolution?: string) {
  const payload: { status?: DisputeStatus; resolution?: string } = {};
  if (status !== undefined) payload.status = status;
  if (resolution !== undefined) payload.resolution = resolution;
  return payload;
}

// ── Service-level concurrency tests ─────────────────────────────────────────

describe('DisputesService — concurrency smoke tests', () => {
  let service: DisputesService;

  beforeEach(() => {
    service = new DisputesService();
    service.clearStore(); // Clear shared in-memory store between tests
  });

  it('parallel writes: 10 concurrent createDispute calls produce 10 disputes with no lost updates', async () => {
    const count = 10;
    const tasks = Array.from({ length: count }, async (_, i) => {
      await Promise.resolve(); // Yield to event loop
      return service.createDispute(createTestDisputeInput(i));
    });

    const results = await Promise.all(tasks);

    expect(results).toHaveLength(count);
    expect(service.storeSize()).toBe(count);

    // Verify all disputes are retrievable
    for (const dispute of results) {
      const retrieved = service.getDisputeById(dispute.id);
      expect(retrieved.id).toBe(dispute.id);
      expect(retrieved.contractId).toBe(dispute.contractId);
    }
  });

  it('parallel writes: 20 concurrent updates to same dispute produce consistent final state', async () => {
    // Create a dispute first
    const dispute = service.createDispute(createTestDisputeInput(0));
    const count = 20;

    // Fire concurrent status updates (all to the same valid state)
    const tasks = Array.from({ length: count }, async () => {
      await Promise.resolve();
      return service.updateDispute(dispute.id, createTestUpdatePayload('under_review'));
    });

    const results = await Promise.all(tasks);

    // All should succeed
    expect(results).toHaveLength(count);
    for (const result of results) {
      expect(result.status).toBe('under_review');
    }

    // Final state should be consistent
    const final = service.getDisputeById(dispute.id);
    expect(final.status).toBe('under_review');
  });

  it('parallel writes: each created dispute is retrievable by id after concurrent creates', async () => {
    const count = 15;
    const results = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        await Promise.resolve();
        return service.createDispute(createTestDisputeInput(i));
      }),
    );

    // Verify each dispute can be retrieved
    for (const dispute of results) {
      const retrieved = service.getDisputeById(dispute.id);
      expect(retrieved).toBeDefined();
      expect(retrieved.id).toBe(dispute.id);
      expect(retrieved.contractId).toBe(dispute.contractId);
    }
  });

  it('read-after-write consistency: listDisputes during concurrent creates never loses updates', async () => {
    const count = 30;
    let inconsistentCount = 0;

    const reader = async (): Promise<void> => {
      for (let i = 0; i < 50; i++) {
        await Promise.resolve();
        const disputes = service.listDisputes();
        const storeCount = service.storeSize();
        // listDisputes should return count matching store size
        if (disputes.length !== storeCount) {
          inconsistentCount += 1;
        }
      }
    };

    const writer = async (): Promise<void> => {
      for (let i = 0; i < count; i++) {
        await Promise.resolve();
        service.createDispute(createTestDisputeInput(i));
      }
    };

    await Promise.all([writer(), reader(), reader()]);

    expect(inconsistentCount).toBe(0);
    expect(service.storeSize()).toBe(count);
  });

  it('parallel writes: state transitions remain valid under concurrent updates', async () => {
    const dispute = service.createDispute(createTestDisputeInput(0));
    const count = 25;

    // Fire concurrent valid transitions (open -> under_review)
    const tasks = Array.from({ length: count }, async () => {
      await Promise.resolve();
      return service.updateDispute(dispute.id, createTestUpdatePayload('under_review'));
    });

    const results = await Promise.all(tasks);

    // All should succeed with valid state
    expect(results).toHaveLength(count);
    for (const result of results) {
      expect(result.status).toBe('under_review');
    }

    // Final state should be valid
    const final = service.getDisputeById(dispute.id);
    expect(final.status).toBe('under_review');
  });

  it('parallel writes: 50 concurrent creates produce correct count with no lost updates', async () => {
    const count = 50;
    const results = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        await Promise.resolve();
        return service.createDispute(createTestDisputeInput(i));
      }),
    );

    expect(results).toHaveLength(count);
    expect(service.storeSize()).toBe(count);

    // Verify all are unique
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(count);
  });

  it('parallel batch operations: multiple concurrent processBatch calls handle isolation', async () => {
    // Seed initial disputes
    for (let i = 0; i < 10; i++) {
      service.createDispute(createTestDisputeInput(i));
    }

    const disputes = service.listDisputes();
    const count = 5;

    // Fire concurrent batch operations on different disputes
    const tasks = Array.from({ length: count }, async (_, i) => {
      await Promise.resolve();
      const dispute = disputes[i % disputes.length];
      return service.processBatch([
        { id: dispute.id, status: 'under_review', resolution: `Batch ${i}` },
      ]);
    });

    const results = await Promise.all(tasks);

    expect(results).toHaveLength(count);
    for (const result of results) {
      expect(result).toHaveLength(1);
      expect(result[0]!.success).toBe(true);
    }
  });

  it('parallel mixed operations: creates, updates, and reads run concurrently without corruption', async () => {
    const createCount = 10;
    const updateCount = 10;
    let readCount = 0;
    let errorCount = 0;

    // Create initial disputes for updates
    const initialDisputes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const dispute = service.createDispute(createTestDisputeInput(i));
      initialDisputes.push(dispute.id);
    }

    const creator = async (): Promise<void> => {
      for (let i = 0; i < createCount; i++) {
        await Promise.resolve();
        try {
          service.createDispute(createTestDisputeInput(100 + i));
        } catch (e) {
          errorCount += 1;
        }
      }
    };

    const updater = async (): Promise<void> => {
      for (let i = 0; i < updateCount; i++) {
        await Promise.resolve();
        try {
          const disputeId = initialDisputes[i % initialDisputes.length];
          service.updateDispute(disputeId, createTestUpdatePayload('under_review'));
        } catch (e) {
          errorCount += 1;
        }
      }
    };

    const reader = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
        try {
          service.listDisputes();
          readCount += 1;
        } catch (e) {
          errorCount += 1;
        }
      }
    };

    await Promise.all([creator(), updater(), reader(), reader()]);

    expect(errorCount).toBe(0);
    expect(readCount).toBeGreaterThan(0);
    expect(service.storeSize()).toBe(createCount + initialDisputes.length);
  });
});

// ── HTTP endpoint-level concurrency tests ────────────────────────────────────

describe('Disputes HTTP endpoints — concurrency smoke tests', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/disputes', createDisputesRouter());
    return app;
  }

  beforeEach(() => {
    mockDisputesEnabled = true;
  });

  it('GET /api/v1/disputes: concurrent reads all succeed with 200', async () => {
    const app = buildApp();
    const count = 20;

    const tasks = Array.from({ length: count }, async () => {
      await Promise.resolve();
      return request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', '10.0.0.1');
    });

    const responses = await Promise.all(tasks);

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body.data).toHaveProperty('disputes');
      expect(res.body.data).toHaveProperty('total');
    }
  });

  it('GET /api/v1/disputes/:id: concurrent reads of different IDs all succeed', async () => {
    const app = buildApp();
    const count = 15;

    // Use valid UUIDs (proper format)
    const uuids = Array.from({ length: count }, (_, i) => 
      `550e8400-e29b-41d4-a716-44665544000${i.toString().padStart(2, '0')}`
    );

    const tasks = Array.from({ length: count }, async (_, i) => {
      await Promise.resolve();
      return request(app)
        .get(`/api/v1/disputes/${uuids[i]}`)
        .set('X-Forwarded-For', '10.0.0.2');
    });

    const responses = await Promise.all(tasks);

    expect(responses).toHaveLength(count);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body.data).toHaveProperty('dispute');
    }
  });

  it('mixed HTTP methods: concurrent GET requests to different endpoints handle without errors', async () => {
    const app = buildApp();
    let errorCount = 0;

    const listReader = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        try {
          await request(app)
            .get('/api/v1/disputes')
            .set('X-Forwarded-For', '10.0.0.3')
            .expect(200);
        } catch (e) {
          errorCount += 1;
        }
      }
    };

    // Use valid UUID-like IDs to pass validation
    const singleReader = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        try {
          await request(app)
            .get(`/api/v1/disputes/123e4567-e89b-12d3-a456-426614174${i.toString().padStart(2, '0')}`)
            .set('X-Forwarded-For', '10.0.0.4')
            .expect(200);
        } catch (e) {
          errorCount += 1;
        }
      }
    };

    await Promise.all([listReader(), listReader(), singleReader()]);

    expect(errorCount).toBe(0);
  });

  it('concurrent requests with different IPs are handled independently', async () => {
    const app = buildApp();
    const count = 10;

    const ipATasks = Array.from({ length: count }, async (_, i) => {
      await Promise.resolve();
      return request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', '192.168.1.1');
    });

    const ipBTasks = Array.from({ length: count }, async (_, i) => {
      await Promise.resolve();
      return request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', '192.168.1.2');
    });

    const [responsesA, responsesB] = await Promise.all([
      Promise.all(ipATasks),
      Promise.all(ipBTasks),
    ]);

    // All requests should succeed regardless of IP
    for (const res of [...responsesA, ...responsesB]) {
      expect(res.status).toBe(200);
    }
  });

  it('feature flag: concurrent requests respect feature flag state', async () => {
    mockDisputesEnabled = false;
    const app = buildApp();
    const count = 10;

    const tasks = Array.from({ length: count }, async () => {
      await Promise.resolve();
      return request(app)
        .get('/api/v1/disputes')
        .set('X-Forwarded-For', '10.0.0.5');
    });

    const responses = await Promise.all(tasks);

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('feature_disabled');
    }
  });
});

