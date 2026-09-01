/**
 * @module modules/overrideRequests/overrideRequest.service
 * @description Business logic for the high-impact override approval workflow.
 *
 * This service enforces all invariants of the approval state machine:
 *
 *   1. Self-approval prevention: the approver must have a different user ID
 *      from the requester. No user can approve their own override request,
 *      regardless of role.
 *
 *   2. Expiry check: any mutating operation first checks whether the request
 *      has passed its `expires_at` deadline. If so, it atomically transitions
 *      the row to `expired` and returns an error — the caller's intended
 *      transition is not executed.
 *
 *   3. State guard: only legal transitions (see LEGAL_TRANSITIONS in types)
 *      are permitted. Attempts to re-approve, re-apply, or apply a rejected
 *      request are refused with a structured error.
 *
 *   4. Idempotency of apply: applying an already-applied request returns a
 *      conflict error ("apply twice" edge case).
 *
 *   5. Tenant isolation: all operations are scoped to the caller's tenant ID.
 *      A request belonging to a different tenant is treated as not found.
 *
 * Every state transition is recorded in the audit log with CRITICAL severity.
 *
 * Security note:
 *  - `reason` and `rejectionReason` fields must not contain raw secrets or PII.
 *    Callers are responsible for sanitising these inputs before the service
 *    receives them. The service stores them verbatim.
 */

import { createLogger } from '../../logger';
import { auditService as defaultAuditService, AuditService } from '../../audit/service';
import type {
  OverrideRequest,
  CreateOverrideRequestInput,
  ApproveOverrideRequestInput,
  RejectOverrideRequestInput,
  ApplyOverrideRequestInput,
  OverrideRequestQuery,
  OverrideRequestListResult,
} from './overrideRequest.types';
import { TERMINAL_STATES } from './overrideRequest.types';
import { OverrideRequestRepository } from './overrideRequest.repository';
import type Database from 'better-sqlite3';

const log = createLogger({ service: 'override-request-service' });

// ─── Custom errors ────────────────────────────────────────────────────────────

export class OverrideRequestNotFoundError extends Error {
  readonly code = 'not_found' as const;
  readonly statusCode = 404;
  constructor(id: string) {
    super(`Override request '${id}' not found.`);
    this.name = 'OverrideRequestNotFoundError';
  }
}

export class OverrideRequestSelfApprovalError extends Error {
  readonly code = 'forbidden' as const;
  readonly statusCode = 403;
  constructor() {
    super('Self-approval is not permitted. The approver must be a different user.');
    this.name = 'OverrideRequestSelfApprovalError';
  }
}

export class OverrideRequestExpiredError extends Error {
  readonly code = 'conflict' as const;
  readonly statusCode = 409;
  constructor(id: string) {
    super(`Override request '${id}' has expired and can no longer be acted upon.`);
    this.name = 'OverrideRequestExpiredError';
  }
}

export class OverrideRequestInvalidTransitionError extends Error {
  readonly code = 'conflict' as const;
  readonly statusCode = 409;
  constructor(from: string, to: string) {
    super(`Transition from '${from}' to '${to}' is not permitted.`);
    this.name = 'OverrideRequestInvalidTransitionError';
  }
}

export class OverrideRequestAlreadyAppliedError extends Error {
  readonly code = 'conflict' as const;
  readonly statusCode = 409;
  constructor(id: string) {
    super(`Override request '${id}' has already been applied.`);
    this.name = 'OverrideRequestAlreadyAppliedError';
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class OverrideRequestService {
  private readonly repo: OverrideRequestRepository;
  private readonly audit: AuditService;

  constructor(db: Database.Database, auditService?: AuditService) {
    this.repo = new OverrideRequestRepository(db);
    // Use injected service (testing) or the process-level default instance
    this.audit = auditService ?? defaultAuditService;
  }

  // ── create ─────────────────────────────────────────────────────────────────

  /**
   * Create a new override request.
   *
   * @param input - Request parameters including requester, resource, and reason.
   * @returns The newly created (persisted) override request.
   */
  create(input: CreateOverrideRequestInput): OverrideRequest {
    const request = this.repo.create(input);

    log.info('Override request created', {
      requestId: request.id,
      tenantId: request.tenantId,
      resourceType: request.resourceType,
      resourceId: request.resourceId,
      overrideAction: request.action,
    });

    // Audit every state entry (REQUESTED = initial state)
    this.emitAudit('OVERRIDE_REQUESTED', request, input.requesterId, {
      reason: request.reason,
      expiresAt: request.expiresAt,
    });

    return request;
  }

  // ── approve ────────────────────────────────────────────────────────────────

  /**
   * Approve an override request.
   *
   * Enforces:
   *  - The approver is not the requester (no self-approval).
   *  - The request has not expired.
   *  - The request is in `requested` status.
   */
  approve(input: ApproveOverrideRequestInput): OverrideRequest {
    const existing = this.repo.findById(input.requestId, input.tenantId);
    if (!existing) {
      throw new OverrideRequestNotFoundError(input.requestId);
    }

    // Self-approval guard — enforced even before expiry check
    if (existing.requesterId === input.approverId) {
      throw new OverrideRequestSelfApprovalError();
    }

    // Expiry check — atomically expire if stale
    const now = new Date().toISOString();
    if (this.isExpired(existing, now)) {
      this.expireAndAudit(existing, input.approverId, now);
      throw new OverrideRequestExpiredError(input.requestId);
    }

    // State guard
    if (existing.status !== 'requested') {
      throw new OverrideRequestInvalidTransitionError(existing.status, 'approved');
    }

    const updated = this.repo.approve(input.requestId, input.tenantId, input.approverId, now);
    if (!updated) {
      // Row was concurrently mutated between our read and write
      throw new OverrideRequestInvalidTransitionError(existing.status, 'approved');
    }

    log.info('Override request approved', {
      requestId: updated.id,
      tenantId: updated.tenantId,
      approverId: input.approverId,
    });

    this.emitAudit('OVERRIDE_APPROVED', updated, input.approverId, {
      previousStatus: existing.status,
    });

    return updated;
  }

  // ── reject ─────────────────────────────────────────────────────────────────

  /**
   * Reject an override request.
   *
   * Valid from both `requested` and `approved` states.
   */
  reject(input: RejectOverrideRequestInput): OverrideRequest {
    const existing = this.repo.findById(input.requestId, input.tenantId);
    if (!existing) {
      throw new OverrideRequestNotFoundError(input.requestId);
    }

    const now = new Date().toISOString();

    // Expiry check
    if (this.isExpired(existing, now)) {
      this.expireAndAudit(existing, input.approverId, now);
      throw new OverrideRequestExpiredError(input.requestId);
    }

    // State guard — terminal states cannot be rejected again
    if (TERMINAL_STATES.has(existing.status)) {
      throw new OverrideRequestInvalidTransitionError(existing.status, 'rejected');
    }

    const updated = this.repo.reject(
      input.requestId,
      input.tenantId,
      input.approverId,
      input.rejectionReason ?? null,
      now,
    );
    if (!updated) {
      throw new OverrideRequestInvalidTransitionError(existing.status, 'rejected');
    }

    log.info('Override request rejected', {
      requestId: updated.id,
      tenantId: updated.tenantId,
      approverId: input.approverId,
    });

    this.emitAudit('OVERRIDE_REJECTED', updated, input.approverId, {
      previousStatus: existing.status,
      // rejectionReason is user-supplied text; log at warn level without
      // echoing it in the log message itself (avoids accidental data leakage)
    });

    return updated;
  }

  // ── apply ──────────────────────────────────────────────────────────────────

  /**
   * Apply an approved override request (execute the override).
   *
   * Only an `approved` request that has not expired may be applied.
   * Attempting to apply an already-applied request returns a structured error.
   */
  apply(input: ApplyOverrideRequestInput): OverrideRequest {
    const existing = this.repo.findById(input.requestId, input.tenantId);
    if (!existing) {
      throw new OverrideRequestNotFoundError(input.requestId);
    }

    // "Apply twice" edge case — specific error for idempotency detection
    if (existing.status === 'applied') {
      throw new OverrideRequestAlreadyAppliedError(input.requestId);
    }

    const now = new Date().toISOString();

    // Expiry check
    if (this.isExpired(existing, now)) {
      this.expireAndAudit(existing, input.actorId, now);
      throw new OverrideRequestExpiredError(input.requestId);
    }

    // State guard — must be approved to apply
    if (existing.status !== 'approved') {
      throw new OverrideRequestInvalidTransitionError(existing.status, 'applied');
    }

    const updated = this.repo.apply(input.requestId, input.tenantId, now);
    if (!updated) {
      // Concurrent expiry or state change between read and write
      const current = this.repo.findById(input.requestId, input.tenantId);
      if (current?.status === 'expired') {
        throw new OverrideRequestExpiredError(input.requestId);
      }
      throw new OverrideRequestInvalidTransitionError(existing.status, 'applied');
    }

    log.info('Override request applied', {
      requestId: updated.id,
      tenantId: updated.tenantId,
      actorId: input.actorId,
    });

    this.emitAudit('OVERRIDE_APPLIED', updated, input.actorId, {
      previousStatus: existing.status,
      approverId: updated.approverId,
    });

    return updated;
  }

  // ── getById ────────────────────────────────────────────────────────────────

  /**
   * Retrieve a single override request by ID (tenant-scoped).
   * Lazily expires the request if its TTL has elapsed.
   */
  getById(id: string, tenantId: string): OverrideRequest {
    const request = this.repo.findById(id, tenantId);
    if (!request) {
      throw new OverrideRequestNotFoundError(id);
    }

    // Lazy expiry — if the TTL has elapsed, transition to expired on read
    const now = new Date().toISOString();
    if (this.isExpired(request, now)) {
      const expired = this.repo.expire(id, tenantId, now);
      if (expired) {
        this.emitAudit('OVERRIDE_EXPIRED', expired, 'system', {
          expiredAt: now,
          previousStatus: request.status,
        });
        return expired;
      }
    }

    return request;
  }

  // ── list ───────────────────────────────────────────────────────────────────

  /**
   * List override requests within a tenant, with optional filters.
   */
  list(query: OverrideRequestQuery): OverrideRequestListResult {
    return this.repo.list(query);
  }

  // ── expireStale ────────────────────────────────────────────────────────────

  /**
   * Bulk-expire all stale requests (TTL elapsed) across all tenants.
   * Intended for a periodic maintenance cron/job.
   *
   * Note: this does NOT emit per-row audit events (bulk expiry is expected
   * to be logged at the scheduler level). Use `getById` for per-request
   * lazy expiry with audit trail.
   *
   * @returns Number of rows expired.
   */
  expireStale(): number {
    const now = new Date().toISOString();
    const count = this.repo.expireAll(now);

    if (count > 0) {
      log.info('Bulk expiry complete', { expiredCount: count });
    }

    return count;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Returns true when the request has elapsed its TTL. */
  private isExpired(request: OverrideRequest, now: string): boolean {
    // Only non-terminal states can expire
    if (TERMINAL_STATES.has(request.status)) return false;
    return request.expiresAt <= now;
  }

  /**
   * Atomically expire a request and record the audit event.
   * Called as a side-effect when a mutating operation detects expiry.
   */
  private expireAndAudit(
    request: OverrideRequest,
    actorId: string,
    now: string,
  ): void {
    const expired = this.repo.expire(request.id, request.tenantId, now);
    const record = expired ?? ({ ...request, status: 'expired' as const } as OverrideRequest);

    log.warn('Override request expired before action could be taken', {
      requestId: request.id,
      tenantId: request.tenantId,
      actorId,
      expiresAt: request.expiresAt,
    });

    this.emitAudit('OVERRIDE_EXPIRED', record, actorId, {
      expiredAt: now,
      previousStatus: request.status,
      actorAttempt: 'transition_blocked_by_expiry',
    });
  }

  /**
   * Emit a CRITICAL-severity audit event for every override state transition.
   * All override events are CRITICAL because they bypass normal approval flows.
   *
   * Audit failures are intentionally swallowed to avoid disrupting the primary
   * request flow. The failure is still logged at error level for observability.
   */
  private emitAudit(
    action:
      | 'OVERRIDE_REQUESTED'
      | 'OVERRIDE_APPROVED'
      | 'OVERRIDE_REJECTED'
      | 'OVERRIDE_APPLIED'
      | 'OVERRIDE_EXPIRED',
    request: OverrideRequest,
    actorId: string,
    extra: Record<string, unknown> = {},
  ): void {
    try {
      this.audit.log({
        action,
        severity: 'CRITICAL',
        actor: actorId,
        resource: 'override-requests',
        resourceId: request.id,
        metadata: {
          tenantId: request.tenantId,
          resourceType: request.resourceType,
          resourceId: request.resourceId,
          overrideAction: request.action,
          status: request.status,
          requesterId: request.requesterId,
          approverId: request.approverId,
          ...extra,
        },
      });
    } catch (err) {
      // Log failures must NOT disrupt the primary operation
      log.error('Failed to emit audit event for override request', {
        requestId: request.id,
        action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
