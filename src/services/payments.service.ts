/**
 * @module services/payments.service
 * @description
 * Core business logic for payment initiation.
 *
 * ## initiatePayment flow
 *  1. Validate the contract exists and is in 'active' status.
 *  2. Verify the sender is the contract's client (ownership check).
 *  3. Verify the recipient is the contract's freelancer.
 *  4. Validate amount > 0 and does not exceed the contract's value.
 *  5. Calculate the sender's rolling 24-hour spend and delegate to
 *     WalletService for balance + limit checks.
 *  6. Persist a 'pending' payment row in the database.
 *  7. Enqueue a PAYMENT_PROCESSING job (idempotency key = paymentId).
 *  8. Stamp the returned job ID onto the row (markProcessing).
 *  9. Emit a PAYMENT_INITIATED audit event.
 * 10. Return the populated Payment record to the caller.
 *
 * If queue enqueue fails after the DB row is created, the row stays in
 * 'pending' status so a background reconciliation sweep can re-enqueue it.
 * This is documented below — it is a deliberate at-least-once design choice.
 *
 * @security
 *  - Sender wallet address is never logged at INFO level.
 *  - Amount is validated as a positive integer before any external call.
 *  - All DB writes use the PaymentRepository prepared statements.
 */

import type { IContractRepository } from '../repositories/contractRepository';
import type { IPaymentRepository } from '../repositories/paymentRepository';
import { DuplicatePaymentError } from '../repositories/paymentRepository';
import { WalletService } from './wallet.service';
import type { Payment } from '../db/types';
import { QueueManager } from '../queue/queue-manager';
import { JobType } from '../queue/types';
import { AuditService } from '../audit/service';
import { createLogger } from '../logger';

const log = createLogger({ service: 'payments' });

// ─── Typed errors ─────────────────────────────────────────────────────────────

export class PaymentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentValidationError';
  }
}

export class ContractNotEligibleError extends Error {
  constructor(contractId: string, reason: string) {
    super(`Contract ${contractId} is not eligible for payment: ${reason}`);
    this.name = 'ContractNotEligibleError';
  }
}

// ─── Input / output ───────────────────────────────────────────────────────────

export interface InitiatePaymentInput {
  /** UUID of the contract being paid. */
  contractId: string;
  /** User ID of the client initiating the payment. Must match contract.clientId. */
  senderId: string;
  /** Stellar public key (G… address) of the sender's wallet. Used for balance check. */
  senderStellarAddress: string;
  /** Amount to transfer in stroops. Must be > 0 and ≤ contract.amount. */
  amount: number;
  /** Tracing context forwarded to the queue job and audit log. */
  correlationId?: string;
  requestId?: string;
}

export interface InitiatePaymentResult {
  payment: Payment;
  /** BullMQ job ID assigned at enqueue time. */
  jobId: string;
  /** True when an existing queued job was reused (idempotent re-submission). */
  deduplicated: boolean;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class PaymentsService {
  constructor(
    private readonly contractRepo: IContractRepository,
    private readonly paymentRepo: IPaymentRepository,
    private readonly walletService: WalletService = new WalletService(),
    private readonly queueManager: QueueManager = QueueManager.getInstance(),
    private readonly auditService: AuditService = new AuditService(),
  ) {}

  /**
   * Initiates a payment for a contract.
   *
   * @throws {PaymentValidationError}   amount ≤ 0 or exceeds contract value
   * @throws {ContractNotEligibleError} contract not found or not 'active'
   * @throws {PaymentValidationError}   sender is not the contract client
   * @throws {DuplicatePaymentError}    a payment already exists for this contract+sender
   * @throws {WalletNotFoundError}      sender Stellar account does not exist
   * @throws {InsufficientBalanceError} sender balance too low
   * @throws {PaymentLimitExceededError} amount > per-payment cap
   * @throws {DailyLimitExceededError}  daily volume cap would be breached
   */
  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    const { contractId, senderId, senderStellarAddress, amount, correlationId, requestId } = input;

    // ── 1. Amount must be a positive integer ──────────────────────────────────
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new PaymentValidationError('Payment amount must be a positive integer (stroops)');
    }

    // ── 2. Contract must exist ────────────────────────────────────────────────
    const contract = await this.contractRepo.findById(contractId);
    if (!contract) {
      throw new ContractNotEligibleError(contractId, 'contract not found');
    }

    // ── 3. Contract must be active ────────────────────────────────────────────
    if (contract.status !== 'active') {
      throw new ContractNotEligibleError(
        contractId,
        `status is '${contract.status}', expected 'active'`,
      );
    }

    // ── 4. Sender must be the contract's client ───────────────────────────────
    if (contract.clientId !== senderId) {
      throw new PaymentValidationError(
        'Only the contract client may initiate a payment for this contract',
      );
    }

    // ── 5. Amount must not exceed the contract value ──────────────────────────
    if (amount > contract.amount) {
      throw new PaymentValidationError(
        `Payment amount ${amount} stroops exceeds contract value of ${contract.amount} stroops`,
      );
    }

    // ── 6. Compute rolling 24-hour spend for this sender ─────────────────────
    const dailySpentStroops = await this.#getDailySpentStroops(senderId);

    // ── 7. Wallet validation (balance + limits) ───────────────────────────────
    //    Throws typed WalletError subclasses on failure — let them propagate
    //    to the controller for correct HTTP status mapping.
    await this.walletService.validatePayment(
      senderStellarAddress,
      amount,
      dailySpentStroops,
    );

    // ── 8. Persist the payment row ('pending') ────────────────────────────────
    //    DuplicatePaymentError is intentionally not caught here — the controller
    //    maps it to HTTP 409 so callers get a clear idempotency signal.
    const payment = await this.paymentRepo.create({
      contractId,
      senderId,
      recipientId: contract.freelancerId,
      amount,
    });

    log.info('Payment record created', { paymentId: payment.id, contractId, amount });

    // ── 9. Enqueue the processing job ─────────────────────────────────────────
    //    dedupeKey = paymentId keeps a second POST with the same Idempotency-Key
    //    from spawning a duplicate job even if the first response was lost.
    let jobId: string;
    let deduplicated: boolean;

    try {
      await this.queueManager.initializeQueue(JobType.PAYMENT_PROCESSING);

      const result = await this.queueManager.addJob(
        JobType.PAYMENT_PROCESSING,
        {
          paymentId: payment.id,
          contractId,
          senderId,
          recipientId: contract.freelancerId,
          amount,
          correlationId,
          requestId,
        },
        {
          dedupeKey: payment.id,
          correlationId,
          requestId,
        },
      );

      jobId = result.jobId;
      deduplicated = result.deduplicated;

      // ── 10. Stamp job ID onto the row ────────────────────────────────────────
      //     Transitions status → 'processing' so the worker and operators know
      //     a job has been assigned.
      await this.paymentRepo.markProcessing(payment.id, jobId);

      log.info('Payment enqueued', { paymentId: payment.id, jobId, deduplicated });
    } catch (err: unknown) {
      // If enqueueing fails the row stays in 'pending'. A reconciliation
      // sweep can detect pending rows with no job_id and re-enqueue them.
      // We log the error but do NOT mark the payment failed — failing fast
      // here would require the client to re-submit which creates a new row.
      log.error('Failed to enqueue payment job; row left in pending state', {
        paymentId: payment.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // ── 11. Audit ─────────────────────────────────────────────────────────────
    try {
      this.auditService.logPaymentEvent(
        'PAYMENT_INITIATED',
        senderId,
        payment.id,
        {
          contractId,
          recipientId: contract.freelancerId,
          amount,
          jobId,
        },
        { correlationId },
      );
    } catch (auditErr: unknown) {
      // Audit failures must never block a successful payment — log and continue.
      log.warn('Audit log write failed for PAYMENT_INITIATED', {
        paymentId: payment.id,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }

    // Return the freshest version of the row (status = 'processing', jobId set)
    const updated = await this.paymentRepo.findById(payment.id);

    return {
      payment: updated ?? payment,
      jobId,
      deduplicated,
    };
  }

  /**
   * Retrieves a single payment by ID.
   *
   * @param id - UUID of the payment row.
   * @returns The Payment or undefined if not found.
   */
  async getPaymentById(id: string): Promise<Payment | undefined> {
    return this.paymentRepo.findById(id);
  }

  /**
   * Lists payments, optionally filtered by contractId.
   *
   * @param options.contractId - When provided, returns only payments for that contract.
   * @returns Array of Payment records, newest first.
   */
  async listPayments(options: { contractId?: string } = {}): Promise<Payment[]> {
    if (options.contractId) {
      return this.paymentRepo.findByContractId(options.contractId);
    }
    // No global findAll on the repo interface — return empty for now.
    // A full admin list endpoint can add findAll() to the repo when needed.
    return [];
  }

  /**
   * Returns the total stroops the sender has successfully spent in the past 24 hours.
   * Only 'completed' payments count — pending/processing/failed rows are excluded
   * so a failed payment doesn't eat into the sender's daily allowance.
   */
  async #getDailySpentStroops(senderId: string): Promise<number> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const payments = await this.paymentRepo.findBySenderId(senderId);

    return payments
      .filter((p) => p.status === 'completed' && p.createdAt >= cutoff)
      .reduce((sum, p) => sum + p.amount, 0);
  }
}
