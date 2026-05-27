import { Router, Request, Response } from 'express';
import { createRateLimiter } from '../middleware/rateLimiter';
import { rateLimitConfig } from '../config/rateLimit';

const router = Router();
const strictLimiter = createRateLimiter(rateLimitConfig.strict);

router.post(
  '/login',
  strictLimiter,
  async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    return res.status(501).json({ error: 'Login not yet implemented' });
  }
);

router.post(
  '/register',
  strictLimiter,
  async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    return res.status(501).json({ error: 'Registration not yet implemented' });
  }
);

router.post(
  '/refresh',
  strictLimiter,
  async (req: Request, res: Response) => {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token is required' });
    }

    return res.status(501).json({ error: 'Token refresh not yet implemented' });
  }
);

router.post(
  '/logout',
  strictLimiter,
  async (_req: Request, res: Response) => {
    return res.status(200).json({ message: 'Logged out successfully' });
  }
);

export default router;