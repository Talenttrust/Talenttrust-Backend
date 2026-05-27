import { Router } from 'express';
import { ConfigController } from '../controllers/config.controller';

const router = Router();

/**
 * @route GET /api/config
 * @description Returns application configuration including allowed assets.
 * @access Public
 */
router.get('/', ConfigController.getConfig);

export default router;
