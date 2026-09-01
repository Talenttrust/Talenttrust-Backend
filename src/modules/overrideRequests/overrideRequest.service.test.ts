/**
 * @file overrideRequest.service.test.ts
 * @description Unit tests for OverrideRequestService.
 *
 * Covers all edge cases from #1221:
 *  - request by operator (happy path)
 *  - self-approval (forbidden)
 *  - expired request (both create→expire and approve→expire)
 *  - rejected request (cannot re-transition)
 *  - apply twice (conflict)
 *
 * Uses an in-memory SQLite database with full migrations so the tests
 * exercise the real SQL layer without touching disk.
 */

import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrations';
import { OverrideRequestService } from '../overrideRequests/overrideRequest.service';
import {
  OverrideRequestNotFoundError,
  OverrideRequestSelfApprovalError,
  OverrideRequestExpiredError,
  OverrideRequestInvalidTransitionError,
  OverrideRequestAlreadyAppliedError,
} from '../overrideRequests/overrideRequest.service';
import { AuditService } from '../../audit/service';
import { createDefaultAuditRepository } from '../../audit/repository';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function makeAuditService(): AuditService {
  return new AuditService(createDefaultAuditRepository());
}

function makeService(db: Database.Database): OverrideRequestService {
  return new OverrideRequestService(db, makeAuditService());
}

const REQUESTER = 'user-requester-001';
const APPROVER = 'user-approver-002';
const TENANT = 'default'; // shared admin tenant (mirrors routes getTenantId for admin/auditor)

const validInput = {
  tenantId: TENANT,
  resourceType: 'contract',
  resourceId: 'contract-abc-123',
  action: 'force_release',
  requesterId: REQUESTER,
  reason: 'Emergency release required due to client emergency circumstances',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OverrideRequestService', () => {
  let db: Database.Database;
  let service: OverrideRequestService;

  beforeEach(() => {
    db = makeDb();
    service = makeService(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── Edge case: request by operator ─────────────────────────────────────────

  describe('create (request by operator)', () => {
    it('creates a request in the requested state', () => {
      const req = service.create(validInput);

      expect(req.id).toBeTruthy();
      expect(req.status).toBe('requested');
      expect(req.tenantId).toBe(TENANT);
      expect(req.requesterId).toBe(REQUESTER);
      expect(req.approverId).toBeNull();
      expect(req.approvedAt).toBeNull();
      expect(req.appliedAt).toBeNull();
      expect(req.rejectedAt).toBeNull();
      expect(req.reason).toBe(validInput.reason);
      expect(new Date(req.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('persists the request and retrieves it by id', () => {
      const created = service.create(validInput);
      const fetched = service.getById(created.id, TENANT);

      expect(fetched.id).toBe(created.id);
      expect(fetched.status).toBe('requested');
    });

    it('returns 404 when retrieving a request from a different tenant', () => {
      const created = service.create(validInput);

      expect(() => service.getById(created.id, 'other-tenant')).toThrow(
        OverrideRequestNotFoundError,
      );
    });

    it('respects a custom ttlMs', () => {
      const shortTtl = 60_000; // 1 minute
      const req = service.create({ ...validInput, ttlMs: shortTtl });
      const expiryMs = new Date(req.expiresAt).getTime();
      const nowMs = Date.now();

      expect(expiryMs - nowMs).toBeLessThanOrEqual(shortTtl + 500);
      expect(expiryMs - nowMs).toBeGreaterThan(shortTtl - 5000);
    });
  });

  // ── Full happy path ─────────────────────────────────────────────────────────

  describe('happy path: requested → approved → applied', () => {
    it('allows a full successful lifecycle', () => {
      const req = service.create(validInput);
      expect(req.status).toBe('requested');

      const approved = service.approve({
        requestId: req.id,
        tenantId: TENANT,
        approverId: APPROVER,
      });
      expect(approved.status).toBe('approved');
      expect(approved.approverId).toBe(APPROVER);
      expect(approved.approvedAt).toBeTruthy();

      const applied = service.apply({
        requestId: req.id,
        tenantId: TENANT,
        actorId: APPROVER,
      });
      expect(applied.status).toBe('applied');
      expect(applied.appliedAt).toBeTruthy();
    });
  });

  // ── Edge case: self-approval ────────────────────────────────────────────────

  describe('self-approval prevention', () => {
    it('throws OverrideRequestSelfApprovalError when requester tries to approve their own request', () => {
      const req = service.create(validInput);

      expect(() =>
        service.approve({
          requestId: req.id,
          tenantId: TENANT,
          approverId: REQUESTER, // same as requesterId — should be blocked
        }),
      ).toThrow(OverrideRequestSelfApprovalError);
    });

    it('self-approval check fires even when the request is not yet expired', () => {
      const req = service.create({ ...validInput, ttlMs: 10 * 60 * 1000 });

      let thrown: Error | null = null;
      try {
        service.approve({ requestId: req.id, tenantId: TENANT, approverId: REQUESTER });
      } catch (e) {
        thrown = e as Error;
      }

      expect(thrown).toBeInstanceOf(OverrideRequestSelfApprovalError);
      expect((thrown as OverrideRequestSelfApprovalError).code).toBe('forbidden');
      expect((thrown as OverrideRequestSelfApprovalError).statusCode).toBe(403);
    });

    it('allows approval by a different user', () => {
      const req = service.create(validInput);
      const result = service.approve({
        requestId: req.id,
        tenantId: TENANT,
        approverId: 'different-user-999',
      });
      expect(result.status).toBe('approved');
    });
  });

  // ── Edge case: expired request ──────────────────────────────────────────────

  describe('expired request handling', () => {
    it('throws OverrideRequestExpiredError when approving an expired request', () => {
      // Create with a TTL that has already elapsed (negative offset)
      const req = service.create({ ...validInput, ttlMs: 1 });

      // Force expiry by manipulating the clock via the repository directly
      db.prepare(
        `UPDATE override_requests SET expires_at = ? WHERE id = ?`,
      ).run('2000-01-01T00:00:00.000Z', req.id);

      expect(() =>
        service.approve({ requestId: req.id, tenantId: TENANT, approverId: APPROVER }),
      ).toThrow(OverrideRequestExpiredError);
    });

    it('throws OverrideRequestExpiredError when applying an expired-approved request', () => {
      const req = service.create(validInput);
      // Approve first
      service.approve({ requestId: req.id, tenantId: TENANT, approverId: APPROVER });

      // Force expiry
      db.prepare(
        `UPDATE override_requests SET expires_at = ? WHERE id = ?`,
      ).run('2000-01-01T00:00:00.000Z', req.id);

      expect(() =>
        service.apply({ requestId: req.id, tenantId: TENANT, actorId: APPROVER }),
      ).toThrow(OverrideRequestExpiredError);
    });

    it('lazily expires a request on getById when TTL has elapsed', () => {
      const req = service.create(validInput);

      // Force past expiry
      db.prepare(
        `UPDATE override_requests SET expires_at = ? WHERE id = ?`,
      ).run('2000-01-01T00:00:00.000Z', req.id);

      const fetched = service.getById(req.id, TENANT);
      expect(fetched.status).toBe('expired');
    });

    it('throws OverrideRequestExpiredError with correct code/statusCode', () => {
      const req = service.create(validInput);
      db.prepare(
        `UPDATE override_requests SET expires_at = ? WHERE id = ?`,
      ).run('2000-01-01T00:00:00.000Z', req.id);

      let thrown: Error | null = null;
      try {
        service.approve({ requestId: req.id, tenantId: TENANT, approverId: APPROVER });
      } catch (e) {
        thrown = e as Error;
      }

      expect(thrown).toBeInstanceOf(OverrideRequestExpiredError);
      expect((thrown as OverrideRequestExpiredError).code).toBe('conflict');
      expect((thrown as OverrideRequestExpiredError).statusCode).toBe(409);
    });

    it('transitions the row to expired when approve is blocked by expiry', () => {
      const req = service.create(validInput);
      db.prepare(
        `UPDATE override_requests SET expires_at = ? WHERE id = ?`,
      ).run('2000-01-01T00:00:00.000Z', req.id);

      try {
        service.approve({ requestId: req.id, tenantId: TENANT, approverId: APPROVER });
      } catch {
        // expected
      }

      const row = db
        .prepare(`SELECT status FROM override_requests WHERE id = ?`)
        .get(req.id) as { status: string };
      expect(row.status).toBe('expired');
    });

    it('expireStale bulk-expires all stale rows', () => {
      service.create(validInput);
      service.create({ ...validInput, resourceId: 'contract-xyz-456' });

      // Force both past expiry
      db.prepare(
        `UPDATE override_requests SET expires_at = '2000-01-01T00:00:00.000Z'`,
      ).run();

      const count = service.expireStale();
      expect(count).toBe(2);

      const rows = db
        .prepare(`SELECT status FROM override_requests`)
        .all() as Array<{ status: string }>;
      expect(rows.every((r) => r.status === 'expired')).toBe(true);
    });
  });

  // ── Edge case: rejected request ─────────────────────────────────────────────

  describe('rejected request', () => {
    it('rejects a request from the requested state', () => {
      const req = service.create(validInput);
      const rejected = service.reject({
        requestId: req.id,
        tenantId: TENANT,
        approverId: APPROVER,
        rejectionReason: 'Not justified',
      });

      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectedAt).toBeTruthy();
      expect(rejected.rejectionReason).toBe('Not justified');
    });

    it('rejects an approved request (approver changes mind)', () => {
      const req = service.create(validInput);
      service.approve({ requestId: req.id, tenantId: TENANT, approverId: APPROVER });

      const rejected = service.reject({
        requestId: req.id,
        tenantId: TENANT,
        approverId: APPROVER,
      });
      expect(rejected.status).toBe('rejected');
    });

    it('throws OverrideRequestInvalidTransitionError when trying to approve a rejected request', () => {
      const req = service.create(validInput);
      service.reject({ requestId: req.id, tenantId: TENANT, approverId: APPROVER });

      expect(() =>
        service.approve({ requestId: req.id, tenantId: TENANT, approverId: APPROVER }),
      ).toThrow(OverrideRequestInvalidTransitionError);
    });

    it('throws OverrideRequestInvalidTransitionError when trying to apply a rejected request', () => {
      const req = service.create(validInput);
      service.reject({ requestId: req.id, tenantId: TENANT, approverId: APPROVER });

      expect(() =>
        service.apply({ requestId: req.id, tenantId: TENANT, actorId: APPROVER }),
      ).toThrow(OverrideRequestInvalidTransitionError);
    });

    it('throws OverrideRequestInvalidTransitionError when trying to reject a rejected request', () => {
      const req = service.create(validInput);
      service.reject({ requestId: req.id, tenantId: TENANT, approverId: APPROVER });

      expect(() =>
        service.reject({ requestId: req.id, tenantId: TENANT, approverId: APPROVER }),
      ).toThrow(OverrideRequestInvalidTransitionError);
    });
  });

  // ── Edge case: apply twice ──────────────────────────────────────────────────

  describe('apply twice prevention', () => {
    it('throws OverrideRequestAlreadyAppliedError on a second apply', () => {
      const req = service.create(validInput);
      service.approve({ requestId: req.id, tenantId: TENANT, approverId: APPROVER });
      service.apply({ requestId: req.id, tenantId: TENANT, actorId: APPROVER });

      expect(() =>
        service.apply({ requestId: req.id, tenantId: TENANT, actorId: APPROVER }),
      ).toThrow(OverrideRequestAlreadyAppliedError);
    });

    it('OverrideRequestAlreadyAppliedError has the correct code and statusCode', () => {
      const req = service.create(validInput);
      service.approve({ requestId: req.id, tenantId: TENANT, approverId: APPROVER });
      service.apply({ requestId: req.id, tenantId: TENANT, actorId: APPROVER });

      let thrown: Error | null = null;
      try {
        service.apply({ requestId: req.id, tenantId: TENANT, actorId: APPROVER });
      } catch (e) {
        thrown = e as Error;
      }

      expect(thrown).toBeInstanceOf(OverrideRequestAlreadyAppliedError);
      expect((thrown as OverrideRequestAlreadyAppliedError).code).toBe('conflict');
      expect((thrown as OverrideRequestAlreadyAppliedError).statusCode).toBe(409);
    });
  });

  // ── Not found ───────────────────────────────────────────────────────────────

  describe('not found', () => {
    it('throws OverrideRequestNotFoundError when id does not exist', () => {
      expect(() =>
        service.getById('nonexistent-id', TENANT),
      ).toThrow(OverrideRequestNotFoundError);
    });

    it('throws OverrideRequestNotFoundError when approving a non-existent request', () => {
      expect(() =>
        service.approve({ requestId: 'nonexistent-id', tenantId: TENANT, approverId: APPROVER }),
      ).toThrow(OverrideRequestNotFoundError);
    });

    it('throws OverrideRequestNotFoundError when rejecting a non-existent request', () => {
      expect(() =>
        service.reject({ requestId: 'nonexistent-id', tenantId: TENANT, approverId: APPROVER }),
      ).toThrow(OverrideRequestNotFoundError);
    });

    it('throws OverrideRequestNotFoundError when applying a non-existent request', () => {
      expect(() =>
        service.apply({ requestId: 'nonexistent-id', tenantId: TENANT, actorId: APPROVER }),
      ).toThrow(OverrideRequestNotFoundError);
    });
  });

  // ── Tenant isolation ────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('cannot approve a request that belongs to a different tenant', () => {
      const req = service.create(validInput);

      // Different tenant – treat as not found
      expect(() =>
        service.approve({ requestId: req.id, tenantId: 'other-tenant', approverId: APPROVER }),
      ).toThrow(OverrideRequestNotFoundError);
    });

    it('cannot apply a request from a different tenant', () => {
      const req = service.create(validInput);
      service.approve({ requestId: req.id, tenantId: TENANT, approverId: APPROVER });

      expect(() =>
        service.apply({ requestId: req.id, tenantId: 'other-tenant', actorId: APPROVER }),
      ).toThrow(OverrideRequestNotFoundError);
    });

    it('lists requests only for the given tenant', () => {
      service.create(validInput); // tenant TENANT
      service.create({ ...validInput, tenantId: 'other-tenant' }); // different tenant

      const result = service.list({ tenantId: TENANT });
      expect(result.total).toBe(1);
      expect(result.items[0].tenantId).toBe(TENANT);
    });
  });

  // ── List / pagination ────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns paginated results', () => {
      for (let i = 0; i < 5; i++) {
        service.create({ ...validInput, resourceId: `resource-${i}` });
      }

      const page1 = service.list({ tenantId: TENANT, limit: 2, offset: 0 });
      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(5);
      expect(page1.limit).toBe(2);
      expect(page1.offset).toBe(0);

      const page2 = service.list({ tenantId: TENANT, limit: 2, offset: 2 });
      expect(page2.items).toHaveLength(2);
    });

    it('filters by status', () => {
      const r1 = service.create({ ...validInput, resourceId: 'r1' });
      service.create({ ...validInput, resourceId: 'r2' });
      service.approve({ requestId: r1.id, tenantId: TENANT, approverId: APPROVER });

      const approved = service.list({ tenantId: TENANT, status: 'approved' });
      expect(approved.total).toBe(1);
      expect(approved.items[0].status).toBe('approved');
    });

    it('filters by requesterId', () => {
      service.create(validInput);
      service.create({ ...validInput, requesterId: 'other-user', resourceId: 'r2' });

      const result = service.list({ tenantId: TENANT, requesterId: REQUESTER });
      expect(result.total).toBe(1);
    });
  });

  // ── Audit emission ───────────────────────────────────────────────────────────

  describe('audit trail', () => {
    it('emits an OVERRIDE_REQUESTED audit event on create', () => {
      const spyAudit = jest.fn().mockReturnValue({ id: 'audit-1' } as any);
      const fakeAudit = { log: spyAudit } as unknown as AuditService;
      const svc = new OverrideRequestService(db, fakeAudit);

      svc.create(validInput);

      expect(spyAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'OVERRIDE_REQUESTED',
          severity: 'CRITICAL',
          resource: 'override-requests',
        }),
      );
    });

    it('emits OVERRIDE_APPROVED on approve', () => {
      const spyAudit = jest.fn().mockReturnValue({ id: 'audit-1' } as any);
      const fakeAudit = { log: spyAudit } as unknown as AuditService;
      const svc = new OverrideRequestService(db, fakeAudit);

      const req = svc.create(validInput);
      spyAudit.mockClear();
      svc.approve({ requestId: req.id, tenantId: TENANT, approverId: APPROVER });

      expect(spyAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'OVERRIDE_APPROVED', severity: 'CRITICAL' }),
      );
    });

    it('emits OVERRIDE_REJECTED on reject', () => {
      const spyAudit = jest.fn().mockReturnValue({ id: 'audit-1' } as any);
      const fakeAudit = { log: spyAudit } as unknown as AuditService;
      const svc = new OverrideRequestService(db, fakeAudit);

      const req = svc.create(validInput);
      spyAudit.mockClear();
      svc.reject({ requestId: req.id, tenantId: TENANT, approverId: APPROVER });

      expect(spyAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'OVERRIDE_REJECTED', severity: 'CRITICAL' }),
      );
    });

    it('emits OVERRIDE_APPLIED on apply', () => {
      const spyAudit = jest.fn().mockReturnValue({ id: 'audit-1' } as any);
      const fakeAudit = { log: spyAudit } as unknown as AuditService;
      const svc = new OverrideRequestService(db, fakeAudit);

      const req = svc.create(validInput);
      svc.approve({ requestId: req.id, tenantId: TENANT, approverId: APPROVER });
      spyAudit.mockClear();
      svc.apply({ requestId: req.id, tenantId: TENANT, actorId: APPROVER });

      expect(spyAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'OVERRIDE_APPLIED', severity: 'CRITICAL' }),
      );
    });

    it('emits OVERRIDE_EXPIRED when expiry is detected on read', () => {
      const spyAudit = jest.fn().mockReturnValue({ id: 'audit-1' } as any);
      const fakeAudit = { log: spyAudit } as unknown as AuditService;
      const svc = new OverrideRequestService(db, fakeAudit);

      const req = svc.create(validInput);
      db.prepare(
        `UPDATE override_requests SET expires_at = ? WHERE id = ?`,
      ).run('2000-01-01T00:00:00.000Z', req.id);

      spyAudit.mockClear();
      svc.getById(req.id, TENANT);

      expect(spyAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'OVERRIDE_EXPIRED', severity: 'CRITICAL' }),
      );
    });

    it('does not leak secrets in audit metadata', () => {
      const spyAudit = jest.fn().mockReturnValue({ id: 'audit-1' } as any);
      const fakeAudit = { log: spyAudit } as unknown as AuditService;
      const svc = new OverrideRequestService(db, fakeAudit);

      svc.create(validInput);

      const call = spyAudit.mock.calls[0][0] as { metadata: Record<string, unknown> };
      const metaStr = JSON.stringify(call.metadata);
      expect(metaStr).not.toMatch(/password|secret|token|private/i);
    });
  });
});
