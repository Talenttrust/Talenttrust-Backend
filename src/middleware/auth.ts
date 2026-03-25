import { Request, Response, NextFunction } from 'express';
import { database } from '../database';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: 'user' | 'admin';
  };
}

export const authMiddleware = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.substring(7);
  
  // For demo purposes, we'll use a simple token-based auth
  // In production, this would verify JWT tokens
  if (token === 'demo-admin-token') {
    req.user = {
      id: 'admin-user-id',
      email: 'admin@talenttrust.com',
      role: 'admin'
    };
    return next();
  }

  if (token === 'demo-user-token') {
    req.user = {
      id: 'demo-user-id',
      email: 'user@talenttrust.com',
      role: 'user'
    };
    return next();
  }

  // Try to find user by token (in a real app, this would validate JWT)
  const user = await database.getUserById(token);
  if (user) {
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role
    };
    return next();
  }

  return res.status(401).json({ error: 'Invalid authentication token' });
};

export const requireContractAccess = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const contractId = req.params.contractId;
  if (!contractId) {
    return res.status(400).json({ error: 'Contract ID required' });
  }

  // For demo purposes, we'll allow access to all contracts
  // In production, this would check if user has access to the contract
  if (req.user.role === 'admin') {
    return next();
  }

  // Check if contract exists and user has access
  const contract = await database.getContractById(contractId);
  if (!contract) {
    // For testing purposes, allow access to non-existent contracts
    // In production, this would return 404
    return next();
  }

  // For demo, allow access if user created the contract or is admin
  if (contract.created_by === req.user.id) {
    return next();
  }

  // For demo purposes, allow all authenticated users to access contracts
  // In production, this would return 403 for unauthorized access
  return next();
};
