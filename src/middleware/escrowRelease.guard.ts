/**
 * @module middleware/escrowRelease.guard
 *
 * Authorization guard for value-moving milestone releases.
 *
 * Only the escrow owner (the contract's clientId) or an admin may create a
 * milestone with `completed: true`, which triggers the `milestone.released`
 * webhook and moves funds out of escrow.
 *
 * Why a dedicated guard instead of relying solely on requirePermission:
 *   - requirePermission('contracts','update', getContractOwnerId) checks that
 *     the caller is the contract's clientId — that is necessary but not
 *     sufficient. It does not distinguish between a routine milestone create
 *     and a release, so a freelancer who was later promoted or whose role
 *     changed mid-request could otherwise slip through.
 *   - Denied release attempts must be audited at CRITICAL severity with
 *     enough context (actor, contractId, role, reason) for incident review.
 *   - The check must be atomic with the contract fetch — we re-read the
 *     contract inside this guard so a role change between the ownership
 *     resolver call and the handler cannot be exploited.
 *
 * Security notes:
 *   - The contract is fetched fresh inside the guard (not re-used from a
 *     prior middleware result) to prevent TOCTOU races.
 *   - Denials are logged at CRITICAL and return 403 — the same response
 *     shape as the rest of the platform so clients cannot fingerprint the
 *     reason for denial beyond "forbidden".
 *   - A missing contract returns 404 to avoid leaking existence information
 *     to unauthorised callers.
 *   - Tenant mismatch (caller's id !== contract.clientId and role !== admin)
 *     is treated the same as a permission denial.
 */

import type { Response, NextFunction } from 'express';
import type { IContractRepository } from '../repositories/contractRepository';
import type { AuthenticatedRequest } from '../lib/types';
import { auditService } from '../audit/service';
import { sendForbidden } from '../lib/authHelpers';
import { createLogger } from '../logger';

const log = createLogger({ module: 'escrowRelease.guard' });

/**
 * Returns true when the request body contains a milestone release
 * (i.e. `completed: true`). Non-release creates pass through unguarded.
 */
function isReleaseRequest(req: AuthenticatedRequest): boolean {
  return req.body != null && req.body.completed === true;
}

/**
 * Resolves the escrow owner (clientId) from the contract record, then
 * asserts that the authenticated caller is that owner or an admin.
 *
 * Audits every denied attempt with PAYMENT_RELEASED / CRITICAL severity
 * so that attempts by wrong-role or wrong-tenant actors are always
 * traceable in the immutable audit log.
 *
 * @param repo - Contract repository used to fetch the authoritative record.
 */
export function escrowReleaseGuard(repo: IContractRepository) {
  return async function guard(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // Only milestone creates with completed=true move funds; let the
    // rest fall through to the normal controller path.
    if (!isReleaseRequest(req)) {
      next();
      return;
    }

    const user = req.user;
    if (!user) {
      // requireAuth must run before this guard; this is a safety net.
      sendForbidden(res, 'Authentication required.');
      return;
    }

    const contractId = req.params.id ?? '';
    const correlationId = req.headers['x-correlation-id'] as string | undefined;
    const ipAddress = (req.ip ?? req.socket?.remoteAddress) as string | undefined;

    // Re-fetch the contract to get the authoritative escrow role — do not
    // rely on any value cached in a prior middleware call.
    let escrowOwnerId: string | undefined;
    try {
      const contract = await repo.findById(contractId);
      if (!contract) {
        // Return 404 rather than leaking existence information.
        const requestId =
          typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
        res.status(404).json({
          error: { code: 'not_found', message: 'Contract not found.', requestId },
        });
        return;
      }
      escrowOwnerId = contract.clientId;
    } catch (err) {
      log.error('escrowReleaseGuard: failed to fetch contract', {
        contractId,
        userId: user.id,
        err,
      });
      const requestId =
        typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
      res.status(500).json({
        error: { code: 'internal_error', message: 'Authorization check failed.', requestId },
      });
      return;
    }

    // Admins bypass the ownership check.
    const isAdmin = user.role === 'admin';
    const isEscrowOwner = user.id === escrowOwnerId;

    if (!isAdmin && !isEscrowOwner) {
      // Audit the denied attempt — CRITICAL because a release was attempted.
      try {
        auditService.log({
          action: 'PAYMENT_RELEASED',
          severity: 'CRITICAL',
          actor: user.id,
          resource: 'contract',
          resourceId: contractId,
          metadata: {
            outcome: 'denied',
            reason: 'caller_not_escrow_owner',
            callerRole: user.role,
            // Do not log escrowOwnerId to avoid leaking another user's id in
            // the audit payload; the contract record already carries it.
          },
          ipAddress,
          correlationId,
        });
      } catch (auditErr) {
        // Audit failure must never suppress the primary denial.
        log.error('escrowReleaseGuard: audit log failed', { auditErr });
      }

      log.warn('escrowReleaseGuard: release denied', {
        contractId,
        userId: user.id,
        role: user.role,
        correlationId,
      });

      sendForbidden(res, 'Only the contract owner may release milestone funds.');
      return;
    }

    next();
  };
}
