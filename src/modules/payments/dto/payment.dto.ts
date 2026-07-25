/**
 * @module modules/payments/dto/payment.dto
 * @description
 * Zod validation schemas and inferred TypeScript types for payment endpoints.
 *
 * Schema coverage:
 *  - initiatePaymentSchema  — POST /api/v1/payments body
 *  - getPaymentParamsSchema — GET  /api/v1/payments/:id path param
 *
 * All monetary values are in stroops (1 XLM = 10 000 000 stroops) and must be
 * positive integers so that the service layer never receives a fractional amount.
 */

import { z } from 'zod';

// ─── Shared constants ─────────────────────────────────────────────────────────

/**
 * Maximum single-payment amount validated at the DTO layer (10 000 XLM in stroops).
 * The WalletService enforces the same cap at runtime; this Zod check gives the
 * client an immediate 400 with a readable message before any DB or network call.
 */
const MAX_AMOUNT_STROOPS = 10_000 * 10_000_000; // 100_000_000_000

/** Stellar public-key regex: G followed by 55 base-32 (uppercase) characters. */
const stellarAddressRegex = /^G[A-Z2-7]{55}$/;

// ─── POST /api/v1/payments ────────────────────────────────────────────────────

export const initiatePaymentSchema = z.object({
  body: z.object({
    /**
     * UUID of the contract this payment is for.
     * The service verifies the contract exists and is 'active'.
     */
    contractId: z.string().uuid({ message: 'contractId must be a valid UUID' }),

    /**
     * Stellar public key of the sender's wallet.
     * Used by WalletService to fetch the on-chain balance before processing.
     */
    senderStellarAddress: z
      .string()
      .regex(stellarAddressRegex, {
        message: 'senderStellarAddress must be a valid Stellar public key (G…)',
      }),

    /**
     * Transfer amount in stroops. Must be a positive integer.
     * 1 XLM = 10 000 000 stroops.
     */
    amount: z
      .number({
        required_error: 'amount is required',
        invalid_type_error: 'amount must be a number',
      })
      .int({ message: 'amount must be an integer (stroops)' })
      .positive({ message: 'amount must be greater than 0' })
      .max(MAX_AMOUNT_STROOPS, {
        message: `amount must not exceed ${MAX_AMOUNT_STROOPS} stroops (10 000 XLM)`,
      }),
  }),
});

export type InitiatePaymentDto = z.infer<typeof initiatePaymentSchema>['body'];

// ─── GET /api/v1/payments/:id ─────────────────────────────────────────────────

export const getPaymentParamsSchema = z.object({
  params: z.object({
    id: z.string().uuid({ message: 'Payment id must be a valid UUID' }),
  }),
});

export type GetPaymentParams = z.infer<typeof getPaymentParamsSchema>['params'];

// ─── GET /api/v1/payments  (list by contract) ─────────────────────────────────

export const listPaymentsQuerySchema = z.object({
  query: z.object({
    contractId: z.string().uuid({ message: 'contractId must be a valid UUID' }).optional(),
  }),
});

export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>['query'];
