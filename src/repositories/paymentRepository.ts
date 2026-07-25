/**
 * PaymentRepository — CRUD and status-transition operations for the `payments` table.
 *
 * Uses prepared statements throughout to prevent SQL injection.
 * The UNIQUE(contract_id, sender_id) constraint on the table prevents duplicate
 * payment rows for the same payer on the same contract; the repository surfaces
 * that as a typed DuplicatePaymentError so the service layer can handle it cleanly.
 *
 * All public methods are async for interface compatibility with potential future
 * async backends (e.g. libsql/turso), even though better-sqlite3 is synchronous.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { Payment, PaymentStatus } from '../db/types';

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when a payment row already exists for (contractId, senderId).
 * Maps to HTTP 409 at the controller layer.
 */
export class DuplicatePaymentError extends Error {
  constructor(contractId: string, senderId: string) {
    super(`A payment already exists for contract ${contractId} by sender ${senderId}`);
    this.name = 'DuplicatePaymentError';
  }
}

/**
 * Thrown when a status-transition or field update targets a row that does not exist.
 */
export class PaymentNotFoundError extends Error {
  constructor(paymentId: string) {
    super(`Payment ${paymentId} not found`);
    this.name = 'PaymentNotFoundError';
  }
}

// ─── Raw row shape ─────────────────────────────────────────────────────────────

interface PaymentRow {
  id: string;
  contract_id: string;
  sender_id: string;
  recipient_id: string;
  amount: number;
  status: string;
  job_id: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    contractId: row.contract_id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    amount: row.amount,
    status: row.status as PaymentStatus,
    jobId: row.job_id,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Input shapes ──────────────────────────────────────────────────────────────

export interface CreatePaymentInput {
  contractId: string;
  senderId: string;
  recipientId: string;
  /** Amount in stroops. Must be > 0. */
  amount: number;
}

// ─── Interface ─────────────────────────────────────────────────────────────────

export interface IPaymentRepository {
  create(input: CreatePaymentInput): Promise<Payment>;
  findById(id: string): Promise<Payment | undefined>;
  findByContractId(contractId: string): Promise<Payment[]>;
  findBySenderId(senderId: string): Promise<Payment[]>;
  /**
   * Stamps the BullMQ job ID onto a pending payment and transitions it to
   * 'processing'. The job ID is written at enqueue time so operators can
   * correlate queue entries with DB rows.
   */
  markProcessing(paymentId: string, jobId: string): Promise<Payment>;
  /** Terminal success — transitions status to 'completed'. */
  markCompleted(paymentId: string): Promise<Payment>;
  /**
   * Terminal failure — transitions status to 'failed' and records the reason
   * so operators can diagnose issues without grepping logs.
   */
  markFailed(paymentId: string, reason: string): Promise<Payment>;
  /** Soft-cancel before processing has begun. */
  markCancelled(paymentId: string): Promise<Payment>;
}

// ─── Implementation ────────────────────────────────────────────────────────────

export class PaymentRepository implements IPaymentRepository {
  constructor(private readonly db: Database.Database) {}

  async create(input: CreatePaymentInput): Promise<Payment> {
    const id = randomUUID();
    const now = new Date().toISOString();

    try {
      this.db
        .prepare<[string, string, string, string, number, string, string]>(
          `INSERT INTO payments
             (id, contract_id, sender_id, recipient_id, amount, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.contractId, input.senderId, input.recipientId, input.amount, now, now);
    } catch (err: unknown) {
      // SQLite UNIQUE constraint violation → surface as domain error
      if (
        err instanceof Error &&
        err.message.includes('UNIQUE constraint failed') &&
        err.message.includes('payments.')
      ) {
        throw new DuplicatePaymentError(input.contractId, input.senderId);
      }
      throw err;
    }

    // Re-read the row so default column values (status etc.) are present
    const row = this.db
      .prepare<[string], PaymentRow>('SELECT * FROM payments WHERE id = ?')
      .get(id);

    if (!row) {
      throw new Error(`Failed to read payment ${id} after insert`);
    }

    return toPayment(row);
  }

  async findById(id: string): Promise<Payment | undefined> {
    const row = this.db
      .prepare<[string], PaymentRow>('SELECT * FROM payments WHERE id = ?')
      .get(id);
    return row ? toPayment(row) : undefined;
  }

  async findByContractId(contractId: string): Promise<Payment[]> {
    const rows = this.db
      .prepare<[string], PaymentRow>(
        'SELECT * FROM payments WHERE contract_id = ? ORDER BY created_at DESC',
      )
      .all(contractId);
    return rows.map(toPayment);
  }

  async findBySenderId(senderId: string): Promise<Payment[]> {
    const rows = this.db
      .prepare<[string], PaymentRow>(
        'SELECT * FROM payments WHERE sender_id = ? ORDER BY created_at DESC',
      )
      .all(senderId);
    return rows.map(toPayment);
  }

  async markProcessing(paymentId: string, jobId: string): Promise<Payment> {
    return this.#transition(paymentId, 'processing', { jobId });
  }

  async markCompleted(paymentId: string): Promise<Payment> {
    return this.#transition(paymentId, 'completed');
  }

  async markFailed(paymentId: string, reason: string): Promise<Payment> {
    return this.#transition(paymentId, 'failed', { failureReason: reason });
  }

  async markCancelled(paymentId: string): Promise<Payment> {
    return this.#transition(paymentId, 'cancelled');
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  #transition(
    paymentId: string,
    status: PaymentStatus,
    extras: { jobId?: string; failureReason?: string } = {},
  ): Payment {
    const now = new Date().toISOString();

    const result = this.db
      .prepare<[string, string | null, string | null, string, string]>(
        `UPDATE payments
         SET status         = ?,
             job_id         = COALESCE(?, job_id),
             failure_reason = COALESCE(?, failure_reason),
             updated_at     = ?
         WHERE id = ?`,
      )
      .run(
        status,
        extras.jobId ?? null,
        extras.failureReason ?? null,
        now,
        paymentId,
      );

    if (result.changes === 0) {
      throw new PaymentNotFoundError(paymentId);
    }

    const row = this.db
      .prepare<[string], PaymentRow>('SELECT * FROM payments WHERE id = ?')
      .get(paymentId);

    if (!row) {
      throw new PaymentNotFoundError(paymentId);
    }

    return toPayment(row);
  }
}
