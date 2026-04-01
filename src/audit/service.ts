/**
 * @module audit/service
 * @description High-level audit logging service.
 *
 * Provides a clean API for application code to emit audit events without
 * coupling directly to the store implementation. All sensitive state changes
 * (contract lifecycle, payments, user management, auth events) must go through
 * this service.
 *
 * Security notes:
 * - Callers MUST sanitise metadata before passing it in — no raw PII.
 * - Logging failures are caught and reported via console.error to avoid
 *   disrupting the primary request flow, but they are also re-thrown in
 *   strict mode so tests can assert on them.
 */

import type { AuditEntry, AuditQuery, AuditSeverity, CreateAuditEntryInput, IntegrityReport } from './types';
import type { AuditAction } from './types';
import { auditStore, AuditStore } from './store';

export interface AuditServiceOptions {
  /** Reserved for future use. */
  _reserved?: never;
}

/**
 * AuditService — application-level facade over AuditStore.
 *
 * @example
 * ```ts
 * import { auditService } from './audit/service';
 *
 * await auditService.log({
 *   action: 'CONTRACT_CREATED',
 *   severity: 'INFO',
 *   actor: req.user.id,
 *   resource: 'contract',
 *   resourceId: contract.id,
 *   metadata: { clientId: contract.clientId },
 *   ipAddress: req.ip,
 *   correlationId: req.headers['x-correlation-id'] as string,
 * });
 * ```
 */
export class AuditService {
  constructor(
    private readonly store: AuditStore = auditStore,
    private readonly options: AuditServiceOptions = {},
  ) {}

  /**
   * Records an audit event.
   *
   * @param input - Event details. metadata must be pre-sanitised.
   * @returns The persisted, immutable AuditEntry.
   * @throws Only when options.strict is true and the store throws.
   */
  log(input: CreateAuditEntryInput): AuditEntry {
    try {
      return this.store.append(input);
    } catch (err) {
      console.error('[AuditService] Failed to persist audit entry:', err);
      throw err;
    }
  }

  /**
   * Convenience wrapper for contract lifecycle events.
   */
  logContractEvent(
    action: Extract<AuditAction, `CONTRACT_${string}`>,
    actor: string,
    contractId: string,
    metadata: Record<string, unknown> = {},
    context: { ipAddress?: string; correlationId?: string } = {},
  ): AuditEntry {
    return this.log({
      action,
      severity: 'INFO',
      actor,
      resource: 'contract',
      resourceId: contractId,
      metadata,
      ...context,
    });
  }

  /**
   * Convenience wrapper for payment events.
   * Payment events are always CRITICAL severity.
   */
  logPaymentEvent(
    action: Extract<AuditAction, `PAYMENT_${string}`>,
    actor: string,
    paymentId: string,
    metadata: Record<string, unknown> = {},
    context: { ipAddress?: string; correlationId?: string } = {},
  ): AuditEntry {
    return this.log({
      action,
      severity: 'CRITICAL',
      actor,
      resource: 'payment',
      resourceId: paymentId,
      metadata,
      ...context,
    });
  }

  /**
   * Convenience wrapper for authentication events.
   * AUTH_FAILED is WARNING; others are INFO.
   */
  logAuthEvent(
    action: Extract<AuditAction, `AUTH_${string}`>,
    actor: string,
    metadata: Record<string, unknown> = {},
    context: { ipAddress?: string; correlationId?: string } = {},
  ): AuditEntry {
    const severity: AuditSeverity = action === 'AUTH_FAILED' ? 'WARNING' : 'INFO';
    return this.log({
      action,
      severity,
      actor,
      resource: 'auth',
      resourceId: actor,
      metadata,
      ...context,
    });
  }

  /**
   * Convenience wrapper for user management events.
   * USER_DELETED is WARNING; others are INFO.
   */
  logUserEvent(
    action: Extract<AuditAction, `USER_${string}`>,
    actor: string,
    targetUserId: string,
    metadata: Record<string, unknown> = {},
    context: { ipAddress?: string; correlationId?: string } = {},
  ): AuditEntry {
    const severity: AuditSeverity = action === 'USER_DELETED' ? 'WARNING' : 'INFO';
    return this.log({
      action,
      severity,
      actor,
      resource: 'user',
      resourceId: targetUserId,
      metadata,
      ...context,
    });
  }

  /**
   * Queries the audit log with optional filters.
   *
   * @param query - Filter and pagination options.
   * @returns Matching entries in insertion order.
   */
  query(query: AuditQuery = {}): AuditEntry[] {
    return this.store.query(query);
  }

  /**
   * Retrieves a single audit entry by ID.
   */
  getById(id: string): AuditEntry | undefined {
    return this.store.getById(id);
  }

  /**
   * Returns the total number of audit entries.
   */
  count(): number {
    return this.store.count();
  }

  /**
   * Verifies the integrity of the entire hash chain.
   * Should be called by a scheduled monitoring job.
   *
   * @returns IntegrityReport — escalate immediately if valid === false.
   */
  verifyIntegrity(): IntegrityReport {
    return this.store.verifyIntegrity();
  }
}

/** Singleton service instance. */
export const auditService = new AuditService();
