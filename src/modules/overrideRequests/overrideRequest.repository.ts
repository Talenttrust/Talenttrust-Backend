/**
 * @module modules/overrideRequests/overrideRequest.repository
 * @description SQLite-backed persistence for override requests.
 *
 * All queries use parameterised prepared statements — no user-provided values
 * are interpolated into SQL strings. Tenant isolation is enforced at every
 * query: every SELECT/UPDATE/DELETE includes a `tenant_id = ?` predicate so
 * rows from one tenant can never bleed into another.
 *
 * JSON metadata is serialised on write and parsed with a safe wrapper on read.
 * Corrupted metadata falls back to `{}` rather than propagating a parse error.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type {
  OverrideRequest,
  OverrideRequestStatus,
  CreateOverrideRequestInput,
  OverrideRequestQuery,
  OverrideRequestListResult,
} from './overrideRequest.types';
import { DEFAULT_OVERRIDE_TTL_MS } from './overrideRequest.types';

// ─── Row shape (what SQLite returns) ─────────────────────────────────────────

interface OverrideRequestRow {
  id: string;
  tenant_id: string;
  resource_type: string;
  resource_id: string;
  action: string;
  requester_id: string;
  approver_id: string | null;
  status: string;
  reason: string;
  rejection_reason: string | null;
  expires_at: string;
  approved_at: string | null;
  applied_at: string | null;
  rejected_at: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeParseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function rowToOverrideRequest(row: OverrideRequestRow): OverrideRequest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    action: row.action,
    requesterId: row.requester_id,
    approverId: row.approver_id,
    status: row.status as OverrideRequestStatus,
    reason: row.reason,
    rejectionReason: row.rejection_reason,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    appliedAt: row.applied_at,
    rejectedAt: row.rejected_at,
    metadata: safeParseMetadata(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Repository ──────────────────────────────────────────────────────────────

export class OverrideRequestRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Persist a new override request.
   * Returns the fully-hydrated record (including server-generated fields).
   */
  create(input: CreateOverrideRequestInput): OverrideRequest {
    const id = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + (input.ttlMs ?? DEFAULT_OVERRIDE_TTL_MS),
    ).toISOString();
    const metadata = JSON.stringify(input.metadata ?? {});

    this.db
      .prepare<
        [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      >(
        `INSERT INTO override_requests
           (id, tenant_id, resource_type, resource_id, action,
            requester_id, status, reason, expires_at, metadata,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.tenantId,
        input.resourceType,
        input.resourceId,
        input.action,
        input.requesterId,
        input.reason,
        expiresAt,
        metadata,
        now,
        now,
      );

    return this.findById(id, input.tenantId) as OverrideRequest;
  }

  /**
   * Fetch a single override request by ID within a tenant.
   * Returns `null` when not found or when the tenant does not match.
   */
  findById(id: string, tenantId: string): OverrideRequest | null {
    const row = this.db
      .prepare<[string, string]>(
        `SELECT * FROM override_requests WHERE id = ? AND tenant_id = ?`,
      )
      .get(id, tenantId) as OverrideRequestRow | undefined;

    return row ? rowToOverrideRequest(row) : null;
  }

  /**
   * List override requests with optional filters, tenant-scoped.
   */
  list(query: OverrideRequestQuery): OverrideRequestListResult {
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;

    const conditions: string[] = ['tenant_id = ?'];
    const params: unknown[] = [query.tenantId];

    if (query.status) {
      conditions.push('status = ?');
      params.push(query.status);
    }
    if (query.requesterId) {
      conditions.push('requester_id = ?');
      params.push(query.requesterId);
    }
    if (query.resourceType) {
      conditions.push('resource_type = ?');
      params.push(query.resourceType);
    }
    if (query.resourceId) {
      conditions.push('resource_id = ?');
      params.push(query.resourceId);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const total = (
      this.db
        .prepare<unknown[]>(`SELECT COUNT(*) as cnt FROM override_requests ${where}`)
        .get(...params) as { cnt: number }
    ).cnt;

    const rows = this.db
      .prepare<unknown[]>(
        `SELECT * FROM override_requests ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as OverrideRequestRow[];

    return {
      items: rows.map(rowToOverrideRequest),
      total,
      limit,
      offset,
    };
  }

  /**
   * Transition an override request to `approved`.
   * Returns the updated record, or `null` if not found/wrong tenant.
   */
  approve(
    id: string,
    tenantId: string,
    approverId: string,
    now: string,
  ): OverrideRequest | null {
    const result = this.db
      .prepare<[string, string, string, string, string]>(
        `UPDATE override_requests
         SET status = 'approved', approver_id = ?, approved_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'requested'`,
      )
      .run(approverId, now, now, id, tenantId);

    if (result.changes === 0) return null;
    return this.findById(id, tenantId);
  }

  /**
   * Transition an override request to `rejected`.
   * Valid from both `requested` and `approved` states.
   */
  reject(
    id: string,
    tenantId: string,
    approverId: string,
    rejectionReason: string | null,
    now: string,
  ): OverrideRequest | null {
    const result = this.db
      .prepare<[string, string | null, string, string, string, string]>(
        `UPDATE override_requests
         SET status = 'rejected', approver_id = ?, rejection_reason = ?,
             rejected_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?
           AND status IN ('requested', 'approved')`,
      )
      .run(approverId, rejectionReason, now, now, id, tenantId);

    if (result.changes === 0) return null;
    return this.findById(id, tenantId);
  }

  /**
   * Transition an override request to `applied`.
   * Only valid when status is `approved` and the request has not expired.
   */
  apply(
    id: string,
    tenantId: string,
    now: string,
  ): OverrideRequest | null {
    const result = this.db
      .prepare<[string, string, string, string]>(
        `UPDATE override_requests
         SET status = 'applied', applied_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?
           AND status = 'approved'
           AND expires_at > ?`,
      )
      .run(now, now, id, tenantId, now);

    if (result.changes === 0) return null;
    return this.findById(id, tenantId);
  }

  /**
   * Expire a single override request (status → 'expired').
   * Used by the expiry sweep and by the service when expiry is detected on read.
   */
  expire(id: string, tenantId: string, now: string): OverrideRequest | null {
    const result = this.db
      .prepare<[string, string, string, string]>(
        `UPDATE override_requests
         SET status = 'expired', updated_at = ?
         WHERE id = ? AND tenant_id = ?
           AND status IN ('requested', 'approved')
           AND expires_at <= ?`,
      )
      .run(now, id, tenantId, now);

    if (result.changes === 0) return null;
    return this.findById(id, tenantId);
  }

  /**
   * Bulk-expire all stale `requested` and `approved` rows across all tenants.
   * Returns the number of rows updated.
   *
   * Intended for a periodic maintenance sweep; not invoked per-request.
   */
  expireAll(now: string): number {
    const result = this.db
      .prepare<[string, string]>(
        `UPDATE override_requests
         SET status = 'expired', updated_at = ?
         WHERE status IN ('requested', 'approved')
           AND expires_at <= ?`,
      )
      .run(now, now);

    return result.changes;
  }
}
