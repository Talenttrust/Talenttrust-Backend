/**
 * @module routes/health
 * @description Health-check route.
 *
 * Used by load balancers and CI smoke tests to verify the service is alive.
 *
 * @route GET /health
 * @returns {{ status: string, service: string }} 200 JSON payload
 */

import { Router, Request, Response } from 'express';

export const healthRouter = Router();

healthRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'talenttrust-backend' });
});
