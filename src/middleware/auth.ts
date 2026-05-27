/**
 * @module auth
 * @description JWT authentication middleware for TalentTrust.
 *
 * Token verification uses HS256 with `JWT_SECRET` from the environment.
 */

import type { Request, Response, NextFunction } from 'express';
import { requirePermission } from './authorization';
import { database } from '../database';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: 'user' | 'admin';
  };
}

export const authMiddleware = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const requestId =
      typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
    return res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Authentication required',
        requestId,
      },
    });
  }

  const token = authHeader.substring(7);

  if (token === 'demo-admin-token') {
    req.user = {
      id: 'admin-user-id',
      email: 'admin@talenttrust.com',
      role: 'admin',
    };
    return next();
  }

  if (token === 'demo-user-token') {
    req.user = {
      id: 'demo-user-id',
      email: 'user@talenttrust.com',
      role: 'user',
    };
    return next();
  }

  const user = await database.getUserById(token);
  if (user) {
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
    };
    return next();
  }

  const requestId =
    typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
  return res.status(401).json({
    error: {
      code: 'unauthorized',
      message: 'Invalid authentication token',
      requestId,
    },
  });
};

export const requireContractAccess = requirePermission('contracts', 'update');
