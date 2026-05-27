/**
 * @module routes/contracts
 * @description Contract metadata routes.
 *
 * Handles CRUD-style operations for TalentTrust escrow contract metadata.
 * Actual on-chain interactions are delegated to the Stellar/Soroban layer
 * (not yet implemented — tracked in docs/backend/architecture.md).
 *
 * @route GET /api/v1/contracts
 * @returns {{ contracts: unknown[] }} 200 JSON payload
 */

import { Router, Request, Response } from 'express';

export const contractsRouter = Router();

contractsRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ contracts: [] });
});
