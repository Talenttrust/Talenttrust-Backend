import { Response, NextFunction } from 'express';
import { Resource, Action } from './roles';
import { AuthenticatedRequest } from './authenticate';
import { isAllowed } from './authorize';
import { getContext, requestContextStorage } from '../context';

export function requirePermission(resource: Resource, action: Action) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const user = req.user;
    const current = getContext() ?? {};
    const enriched = { ...current, actorId: user.id };
    requestContextStorage.run(enriched, () => {
      if (!isAllowed(user.role, resource, action)) {
        res.status(403).json({ error: 'Forbidden: insufficient permissions' });
        return;
      }
      next();
    });
  };
}
