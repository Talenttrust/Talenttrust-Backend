import express, { Request, Response } from 'express';
import {
  authenticateMiddleware,
  requirePermission,
  AuthenticatedRequest,
} from './auth';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// --- Public routes ---

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'talenttrust-backend' });
});

// --- Protected routes ---

app.get(
  '/api/v1/contracts',
  authenticateMiddleware,
  requirePermission('contracts', 'read'),
  (_req: AuthenticatedRequest, res: Response) => {
    res.json({ contracts: [] });
  },
);

app.post(
  '/api/v1/contracts',
  authenticateMiddleware,
  requirePermission('contracts', 'create'),
  (_req: AuthenticatedRequest, res: Response) => {
    res.status(201).json({ contract: { id: 'new' } });
  },
);

app.get(
  '/api/v1/users',
  authenticateMiddleware,
  requirePermission('users', 'read'),
  (_req: AuthenticatedRequest, res: Response) => {
    res.json({ users: [] });
  },
);

app.delete(
  '/api/v1/users/:id',
  authenticateMiddleware,
  requirePermission('users', 'delete'),
  (req: AuthenticatedRequest, res: Response) => {
    res.json({ deleted: req.params.id });
  },
);

app.get(
  '/api/v1/disputes',
  authenticateMiddleware,
  requirePermission('disputes', 'read'),
  (_req: AuthenticatedRequest, res: Response) => {
    res.json({ disputes: [] });
  },
);

app.delete(
  '/api/v1/disputes/:id',
  authenticateMiddleware,
  requirePermission('disputes', 'delete'),
  (req: AuthenticatedRequest, res: Response) => {
    res.json({ deleted: req.params.id });
  },
);

export { app };

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`TalentTrust API listening on http://localhost:${PORT}`);
  });
}
