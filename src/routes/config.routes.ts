import { Router } from 'express';
import { ConfigController } from '../controllers/config.controller';

const router = Router();

/**
 * @route GET /api/config
 * @description Returns application configuration including allowed assets.
 * @access Public
 */
router.get('/', ConfigController.getConfig);

router.post('/', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

export default router;
