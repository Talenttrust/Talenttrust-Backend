/**
 * @module modules/overrideRequests/types
 * @description Domain types for the high-impact override approval workflow.
 *
 * State machine:
 *
 *   requested ──► approved ──► applied  (happy path)
 *       │             │
 *       ▼             ▼
 *    rejected      rejected
 *       (or)       (or)
 *    expired       expired
 *
 * Transitions:
 *  - requested  → approved  : a *different* user with sufficient role approves
 *  - requested  → rejected  : any approver rejects
 *  - approved   → applied   : original requester or admin triggers application
 *  - approved   → rejected  : approver changes mind before apply
 *  - requested/approved → expired : TTL elapsed without progression
 *
 * Invariants enforced at service layer:
 *  - requester_id ≠ approver_id  (no self-approval)
 *  - Terminal states (applied, rejected, expired) are immutable
 *  - expires_at is evaluated on every mutating operation
 *  - tenant_id scope prevents cross-tenant access
 */

/** Valid states for an override request. */
export type OverrideRequestStatus =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'expired';

/** Terminal states — no further transitions are possible. */
export const TERMINAL_STATES: ReadonlySet<OverrideRequestStatus> = new Set([
  'applied',
  'rejected',
  'expired',
]);

/** Legal state transitions (from → to). */
export const LEGAL_TRANSITIONS: Readonly<
  Partial<Record<OverrideRequestStatus, ReadonlyArray<OverrideRequestStatus>>>
> = {
  requested: ['approved', 'rejected'],
  approved: ['applied', 'rejected'],
};

/**
 * A fully-hydrated override request record (as stored and returned by the API).
 */
export interface OverrideRequest {
  /** UUID v4, primary key. */
  readonly id: string;
  /** Tenant owning this request — must match the caller's tenant context. */
  readonly tenantId: string;
  /** Domain type of the resource being overridden (e.g. 'contract', 'payout'). */
  readonly resourceType: string;
  /** Identifier of the specific resource instance. */
  readonly resourceId: string;
  /**
   * The action being requested (e.g. 'force_release', 'emergency_cancel').
   * Free-form string; the caller defines semantics and documents them in `reason`.
   */
  readonly action: string;
  /** User ID of the operator who created this request. */
  readonly requesterId: string;
  /** User ID of the operator who approved or rejected this request (set when action taken). */
  readonly approverId: string | null;
  /** Current state in the approval state machine. */
  readonly status: OverrideRequestStatus;
  /**
   * Human-readable justification for the override (≥ 10, ≤ 5000 chars).
   * Stored in the audit trail — must not contain raw secrets or PII.
   */
  readonly reason: string;
  /** Reason provided by the approver when rejecting (optional). */
  readonly rejectionReason: string | null;
  /** ISO-8601: when this request expires if not acted upon. */
  readonly expiresAt: string;
  /** ISO-8601: when the request was approved (null until approved). */
  readonly approvedAt: string | null;
  /** ISO-8601: when the override was actually applied (null until applied). */
  readonly appliedAt: string | null;
  /** ISO-8601: when the request was rejected (null unless rejected). */
  readonly rejectedAt: string | null;
  /** Arbitrary structured context (sanitised by caller). */
  readonly metadata: Record<string, unknown>;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 last-updated timestamp. */
  readonly updatedAt: string;
}

/** Input for creating a new override request. */
export interface CreateOverrideRequestInput {
  tenantId: string;
  resourceType: string;
  resourceId: string;
  action: string;
  requesterId: string;
  reason: string;
  /** TTL in milliseconds from now (default: 24 hours). */
  ttlMs?: number;
  metadata?: Record<string, unknown>;
}

/** Input for approving an override request. */
export interface ApproveOverrideRequestInput {
  requestId: string;
  tenantId: string;
  approverId: string;
}

/** Input for rejecting an override request. */
export interface RejectOverrideRequestInput {
  requestId: string;
  tenantId: string;
  approverId: string;
  rejectionReason?: string;
}

/** Input for applying an approved override request. */
export interface ApplyOverrideRequestInput {
  requestId: string;
  tenantId: string;
  actorId: string;
}

/** Query filters for listing override requests. */
export interface OverrideRequestQuery {
  tenantId: string;
  status?: OverrideRequestStatus;
  requesterId?: string;
  resourceType?: string;
  resourceId?: string;
  /** Maximum results to return (default: 50, max: 200). */
  limit?: number;
  /** Zero-based offset for pagination. */
  offset?: number;
}

/**
 * Paginated list result for override requests.
 */
export interface OverrideRequestListResult {
  items: OverrideRequest[];
  total: number;
  limit: number;
  offset: number;
}

/** Default TTL applied to new override requests: 24 hours. */
export const DEFAULT_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1000;
