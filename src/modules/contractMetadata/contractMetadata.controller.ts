import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { contractMetadataService } from './contractMetadata.service';
import { CreateContractMetadataRequest, UpdateContractMetadataRequest } from './contractMetadata.types';

/**
 * Controller layer for contract metadata operations
 * Handles HTTP requests and responses
 */
export class ContractMetadataController {
  /**
   * Create a new contract metadata record
   * @param req - Express request with authentication
   * @param res - Express response
   * @returns 201 with created metadata or error response
   */
  async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { contractId } = req.params;
      const data: CreateContractMetadataRequest = req.body;

      const result = await contractMetadataService.create(
        contractId,
        data,
        req.user.id
      );

      res.status(201).json(result);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Contract not found') {
          res.status(404).json({ error: error.message });
        } else if (error.message === 'Metadata key already exists for this contract') {
          res.status(409).json({ error: error.message });
        } else {
          res.status(500).json({ error: 'Internal server error' });
        }
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  }

  /**
   * Get metadata records for a contract
   * @param req - Express request with authentication and query params
   * @param res - Express response
   * @returns 200 with paginated metadata list or error response
   */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { contractId } = req.params;
      const { page, limit, key, data_type } = req.query as any;

      const result = await contractMetadataService.list(
        contractId,
        {
          page: page ? parseInt(page) : undefined,
          limit: limit ? parseInt(limit) : undefined,
          key,
          data_type
        },
        req.user
      );

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Get a single metadata record by ID
   * @param req - Express request with authentication and params
   * @param res - Express response
   * @returns 200 with metadata record or 404 if not found
   */
  async getById(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { id } = req.params;
      const result = await contractMetadataService.getById(id, req.user);

      if (!result) {
        res.status(404).json({ error: 'Metadata not found' });
        return;
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Update a metadata record
   * @param req - Express request with authentication, params, and body
   * @param res - Express response
   * @returns 200 with updated metadata or error response
   */
  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { id } = req.params;
      const updates: UpdateContractMetadataRequest = req.body;

      // Check if attempting to update immutable fields
      if ('key' in updates || 'data_type' in updates) {
        res.status(422).json({ 
          error: 'Cannot update immutable fields: key, data_type' 
        });
        return;
      }

      const result = await contractMetadataService.update(
        id,
        updates,
        req.user.id,
        req.user
      );

      if (!result) {
        res.status(404).json({ error: 'Metadata not found' });
        return;
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Soft delete a metadata record
   * @param req - Express request with authentication and params
   * @param res - Express response
   * @returns 204 on success or error response
   */
  async delete(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { id } = req.params;
      await contractMetadataService.delete(id);

      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

export const contractMetadataController = new ContractMetadataController();
