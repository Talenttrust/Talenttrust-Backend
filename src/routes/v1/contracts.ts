/**
 * Contracts API v1
 * Handles contract-related endpoints for API version 1
 */

import { Router, Request, Response } from 'express';

const router = Router();

/**
 * GET /api/v1/contracts
 * List all contracts
 * 
 * @returns {Object} List of contracts
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    version: 'v1',
    contracts: [],
    message: 'Contract listing endpoint',
  });
});

/**
 * GET /api/v1/contracts/:id
 * Get contract by ID
 * 
 * @param {string} id - Contract ID
 * @returns {Object} Contract details
 */
router.get('/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  res.json({
    version: 'v1',
    contract: {
      id,
      status: 'active',
      createdAt: new Date().toISOString(),
    },
  });
});

export default router;
