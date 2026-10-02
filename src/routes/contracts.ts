/**
 * @module routes/contracts
 * @description Contract metadata routes.
 *
 * Guarded by the CONTRACTS_ENABLED feature flag (default: true).
 * Set CONTRACTS_ENABLED=false to disable all contracts endpoints at runtime
 * without a redeploy.
 *
 * @route GET /api/v1/contracts
 * @returns {{ contracts: unknown[] }} 200 JSON payload
 * @returns {{ error: string }} 503 when CONTRACTS_ENABLED=false
 */

import { Router, Request, Response } from 'express';
import { parseBoolEnv } from '../config/env';

export const contractsRouter = Router();

contractsRouter.get('/', (_req: Request, res: Response) => {
  if (!parseBoolEnv('CONTRACTS_ENABLED', true)) {
    res.status(503).json({ error: 'Contracts feature is disabled' });
    return;
  }
  res.status(200).json({ contracts: [] });
});
