/**
 * @module controllers/payments.controller
 * @description
 * HTTP presentation layer for the payments resource.
 *
 * Handlers:
 *  POST   /api/v1/payments          → initiatePayment
 *  GET    /api/v1/payments/:id      → getPaymentById
 *  GET    /api/v1/payments          → listPayments  (filter by ?contractId=)
 *
 * Each handler:
 *  - extracts and validates request data (already checked by Zod middleware)
 *  - delegates to PaymentsService
 *  - maps domain errors to HTTP status codes
 *  - never leaks internal details in error bodies
 */

import { Request, Response, NextFunction } from 'express';
import { PaymentsService, PaymentValidationError, ContractNotEligibleError } from '../services/payments.service';
import { DuplicatePaymentError } from '../repositories/paymentRepository';
import {
  WalletNotFoundError,
  InsufficientBalanceError,
  PaymentLimitExceededError,
  DailyLimitExceededError,
  WalletServiceUnavailableError,
} from '../services/wallet.service';
import type { AuthenticatedRequest } from '../lib/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requestId(res: Response): string {
  return typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
}

function errorBody(code: string, message: string, res: Response) {
  return { error: { code, message, requestId: requestId(res) } };
}

// ─── Controller factory ────────────────────────────────────────────────────────

export function createPaymentsController(service: PaymentsService) {
  /**
   * POST /api/v1/payments
   *
   * Initiates a payment for a contract. The authenticated user is treated as
   * the sender — their JWT sub is used as senderId so callers cannot spoof it.
   *
   * Body (validated by initiatePaymentSchema middleware):
   *   { contractId, senderStellarAddress, amount }
   *
   * Returns 202 Accepted: the payment is persisted and queued; the caller
   * should poll GET /api/v1/payments/:id to track status to 'completed'.
   */
  async function initiatePayment(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { contractId, senderStellarAddress, amount } = req.body as {
        contractId: string;
        senderStellarAddress: string;
        amount: number;
      };

      const senderId = req.user!.id;
      const correlationId =
        typeof req.headers['x-correlation-id'] === 'string'
          ? req.headers['x-correlation-id']
          : undefined;

      const result = await service.initiatePayment({
        contractId,
        senderId,
        senderStellarAddress,
        amount,
        correlationId,
        requestId: requestId(res),
      });

      res.status(202).json({
        status: 'accepted',
        data: {
          payment: result.payment,
          jobId: result.jobId,
          deduplicated: result.deduplicated,
        },
      });
    } catch (err: unknown) {
      // ── Domain → HTTP mapping ─────────────────────────────────────────────

      if (err instanceof PaymentValidationError) {
        res.status(400).json(errorBody('validation_error', err.message, res));
        return;
      }

      if (err instanceof ContractNotEligibleError) {
        res.status(422).json(errorBody('contract_not_eligible', err.message, res));
        return;
      }

      if (err instanceof DuplicatePaymentError) {
        res.status(409).json(errorBody('duplicate_payment', err.message, res));
        return;
      }

      if (err instanceof WalletNotFoundError) {
        res.status(422).json(errorBody('wallet_not_found', err.message, res));
        return;
      }

      if (err instanceof InsufficientBalanceError) {
        res.status(422).json(errorBody('insufficient_balance', err.message, res));
        return;
      }

      if (err instanceof PaymentLimitExceededError) {
        res.status(422).json(errorBody('payment_limit_exceeded', err.message, res));
        return;
      }

      if (err instanceof DailyLimitExceededError) {
        res.status(422).json(errorBody('daily_limit_exceeded', err.message, res));
        return;
      }

      if (err instanceof WalletServiceUnavailableError) {
        res.status(503).json(errorBody('wallet_service_unavailable', err.message, res));
        return;
      }

      // Unhandled errors → Express error handler
      next(err);
    }
  }

  /**
   * GET /api/v1/payments/:id
   *
   * Returns a single payment record by UUID.
   * The requirePermission middleware already enforces ownOnly for
   * client/freelancer roles before this handler runs.
   */
  async function getPaymentById(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const payment = await service.getPaymentById(req.params.id!);
      if (!payment) {
        res.status(404).json(errorBody('not_found', 'Payment not found', res));
        return;
      }
      res.status(200).json({ status: 'success', data: { payment } });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/payments?contractId=<uuid>
   *
   * Lists payments. When `contractId` is provided, filters to that contract.
   * Without it, returns all payments visible to the authenticated user.
   */
  async function listPayments(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const contractId =
        typeof req.query['contractId'] === 'string' ? req.query['contractId'] : undefined;

      const payments = await service.listPayments({ contractId });
      res.status(200).json({ status: 'success', data: { payments } });
    } catch (err) {
      next(err);
    }
  }

  return { initiatePayment, getPaymentById, listPayments };
}
