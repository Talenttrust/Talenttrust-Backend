/**
 * @module routes/payments.routes
 * @description
 * Express router for the payments resource.
 *
 * Routes:
 *   POST   /                  initiatePayment  (client only)
 *   GET    /                  listPayments     (admin/auditor = all; client/freelancer = own)
 *   GET    /:id               getPaymentById   (admin/auditor = any; client/freelancer = own)
 *
 * Security:
 *   - All routes require a valid JWT (requireAuth).
 *   - Fine-grained access uses requirePermission which consults the
 *     PERMISSION_MATRIX defined in src/lib/authorization.ts:
 *       payments.create → client:ALLOW,  freelancer:DENY
 *       payments.read   → client:OWN,    freelancer:OWN,  admin/auditor:ALLOW
 *       payments.list   → client:OWN,    freelancer:OWN,  admin/auditor:ALLOW
 *   - For ownOnly checks the resolver returns the payment's senderId so the
 *     matrix's OWN rule fires correctly for both client and freelancer.
 *
 * Idempotency:
 *   POST / accepts an optional `Idempotency-Key` header via the shared
 *   idempotency middleware so retried requests replay the cached response
 *   rather than creating a duplicate payment row.
 */

import { Router } from 'express';
import { createPaymentsController } from '../controllers/payments.controller';
import { PaymentsService } from '../services/payments.service';
import { PaymentRepository } from '../repositories/paymentRepository';
import { ContractRepository } from '../repositories/contractRepository';
import { getDb } from '../db/database';
import { requireAuth, requirePermission } from '../middleware/authorization';
import { validateSchema } from '../middleware/validate.middleware';
import { initiatePaymentSchema } from '../modules/payments/dto/payment.dto';
import { createIdempotencyMiddleware } from '../middleware/idempotency';
import type { AuthenticatedRequest } from '../lib/types';

function createPaymentsRouter(): Router {
  const router = Router();
  const db = getDb();

  const paymentRepo = new PaymentRepository(db);
  const contractRepo = new ContractRepository(db);
  const service = new PaymentsService(contractRepo, paymentRepo);
  const controller = createPaymentsController(service);

  /**
   * Resolves the senderId of a payment for ownOnly permission checks.
   * Returns null when the payment does not exist (triggers 404).
   */
  const getPaymentOwnerId = async (req: AuthenticatedRequest): Promise<string | null> => {
    const payment = await paymentRepo.findById(req.params?.id ?? '');
    return payment ? payment.senderId : null;
  };

  // ── POST / — initiate a new payment ────────────────────────────────────────
  router.post(
    '/',
    requireAuth,
    requirePermission('payments', 'create'),
    createIdempotencyMiddleware(),
    validateSchema(initiatePaymentSchema),
    controller.initiatePayment,
  );

  // ── GET / — list payments ───────────────────────────────────────────────────
  router.get(
    '/',
    requireAuth,
    requirePermission('payments', 'list'),
    controller.listPayments,
  );

  // ── GET /:id — fetch a single payment ───────────────────────────────────────
  router.get(
    '/:id',
    requireAuth,
    requirePermission('payments', 'read', getPaymentOwnerId),
    controller.getPaymentById,
  );

  return router;
}

export default createPaymentsRouter();
