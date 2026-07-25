/**
 * Payment Processing Processor
 *
 * Executes the async leg of a payment after it has been persisted and queued.
 * By the time this worker runs, the payments row already exists with status
 * 'processing' and a job_id stamped on it.
 *
 * ## Responsibilities
 *  1. Load the payment row to confirm it is still in a processable state.
 *  2. Invoke the Soroban escrow-release call (real implementation wired here;
 *     currently delegates to SorobanService which will be replaced with the
 *     actual Stellar SDK call when the on-chain contract is deployed).
 *  3. On success  → mark the payment 'completed' in the DB + emit audit event.
 *  4. On failure  → mark the payment 'failed' with the reason string.
 *     BullMQ will still retry the job per the retry policy; each retry
 *     re-checks current status so a job that was externally cancelled won't
 *     be re-processed.
 *
 * ## Idempotency
 *  If the row is already 'completed' when the worker runs (e.g. a retry after
 *  a successful-but-unacknowledged job) the processor returns success without
 *  re-calling Soroban. This makes every execution safe to replay.
 */

import { PaymentProcessingPayload, JobResult } from '../types';
import { createLogger } from '../../logger';
import { SorobanService } from '../../services/soroban.service';
import { PaymentRepository } from '../../repositories/paymentRepository';
import { AuditService } from '../../audit/service';
import { getDb } from '../../db/database';

const soroban = new SorobanService();
const auditService = new AuditService();

/**
 * Process a single payment job.
 *
 * @param payload - Typed PaymentProcessingPayload from the queue.
 * @returns JobResult indicating success or failure.
 * @throws Error on unrecoverable failures (triggers BullMQ retry / dead-letter).
 */
export async function processPaymentProcessing(
  payload: PaymentProcessingPayload,
): Promise<JobResult> {
  const log = createLogger({
    processor: 'payment',
    paymentId: payload.paymentId,
    ...(payload.correlationId && { correlationId: payload.correlationId }),
    ...(payload.requestId && { requestId: payload.requestId }),
  });

  // ── Validate payload ────────────────────────────────────────────────────────
  if (!payload.paymentId || payload.paymentId.length < 10) {
    log.warn('Payment processing rejected: invalid paymentId');
    throw new Error('Invalid paymentId in job payload');
  }

  if (!Number.isInteger(payload.amount) || payload.amount <= 0) {
    log.warn('Payment processing rejected: invalid amount', { amount: payload.amount });
    throw new Error('Invalid amount in job payload');
  }

  const repo = new PaymentRepository(getDb());

  // ── Load current payment state ──────────────────────────────────────────────
  const payment = await repo.findById(payload.paymentId);

  if (!payment) {
    // Row was deleted between enqueue and processing — nothing to do.
    log.warn('Payment row not found; skipping');
    return {
      success: false,
      message: `Payment ${payload.paymentId} not found`,
    };
  }

  // ── Idempotency guard ────────────────────────────────────────────────────────
  if (payment.status === 'completed') {
    log.info('Payment already completed; skipping duplicate execution');
    return {
      success: true,
      message: `Payment ${payload.paymentId} already completed`,
      data: { paymentId: payload.paymentId, status: 'completed' },
    };
  }

  if (payment.status === 'cancelled' || payment.status === 'failed') {
    log.info('Payment is in terminal state; skipping', { status: payment.status });
    return {
      success: false,
      message: `Payment ${payload.paymentId} is in terminal state '${payment.status}'`,
    };
  }

  log.info('Processing payment', { contractId: payload.contractId, amount: payload.amount });

  // ── Execute the on-chain escrow release ─────────────────────────────────────
  try {
    // SorobanService.prepareEscrow will be replaced with a proper
    // releaseEscrow / transfer call once the on-chain contract is deployed.
    // Using prepareEscrow here keeps the integration point explicit and easy
    // to swap without touching the processor interface.
    const released = await soroban.prepareEscrow(payload.contractId, payload.amount);

    if (!released) {
      throw new Error('Soroban escrow release returned false');
    }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error('Soroban call failed; marking payment failed', { reason });

    try {
      await repo.markFailed(payload.paymentId, reason);
    } catch (dbErr: unknown) {
      log.error('Failed to persist failure state', {
        dbError: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }

    // Emit audit event for the failure
    try {
      auditService.logPaymentEvent(
        'PAYMENT_DISPUTED',
        payload.senderId,
        payload.paymentId,
        { contractId: payload.contractId, reason },
        { correlationId: payload.correlationId },
      );
    } catch {
      // Audit failures must not suppress the primary error
    }

    // Re-throw so BullMQ applies the retry policy
    throw err;
  }

  // ── Persist success ─────────────────────────────────────────────────────────
  try {
    await repo.markCompleted(payload.paymentId);
  } catch (dbErr: unknown) {
    // DB update failed after on-chain success — log prominently but don't
    // re-throw (re-throwing would cause a retry which could double-release).
    // The idempotency guard at the top of this function protects subsequent
    // retries, but the discrepancy must be investigated by an operator.
    log.error('CRITICAL: on-chain release succeeded but DB update failed', {
      paymentId: payload.paymentId,
      dbError: dbErr instanceof Error ? dbErr.message : String(dbErr),
    });
  }

  // ── Audit ───────────────────────────────────────────────────────────────────
  try {
    auditService.logPaymentEvent(
      'PAYMENT_RELEASED',
      payload.senderId,
      payload.paymentId,
      {
        contractId: payload.contractId,
        recipientId: payload.recipientId,
        amount: payload.amount,
      },
      { correlationId: payload.correlationId },
    );
  } catch {
    // Audit failures must not block a successful payment result
  }

  log.info('Payment completed successfully');

  return {
    success: true,
    message: `Payment ${payload.paymentId} released`,
    data: {
      paymentId: payload.paymentId,
      contractId: payload.contractId,
      status: 'completed',
      timestamp: new Date().toISOString(),
    },
  };
}
