import { Router } from 'express';

/**
 * @notice Build the health and status routes.
 */
export function createHealthRouter(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'talenttrust-backend' });
  });

  return router;
}
