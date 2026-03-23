import { Router } from 'express';

import { ApiError } from '../errors/ApiError';
import { ContractService } from '../services/contract-service';
import type { CreateContractInput } from '../types/contract';

/**
 * @notice Build the contract routes with an injected service for test isolation.
 * @param contractService Service used to read and create contract records.
 */
export function createContractRouter(contractService: ContractService): Router {
  const router = Router();

  router.get('/api/v1/contracts', (_req, res) => {
    res.json({ contracts: contractService.listContracts() });
  });

  router.get('/api/v1/contracts/:id', (req, res) => {
    validateIdentifier(req.params.id);
    const contract = contractService.getContractById(req.params.id);

    if (!contract) {
      throw new ApiError(404, 'Contract not found.');
    }

    res.json({ contract });
  });

  router.post('/api/v1/contracts', (req, res) => {
    const payload = validateCreateContractBody(req.body);
    const created = contractService.createContract(payload);
    res.status(201).json({ contract: created });
  });

  return router;
}

/**
 * @notice Validate a contract identifier before lookup.
 * @param id Contract identifier from the request path.
 */
export function validateIdentifier(id: string): void {
  if (!/^[A-Za-z0-9-]{3,64}$/.test(id)) {
    throw new ApiError(400, 'Contract id is invalid.');
  }
}

/**
 * @notice Validate the JSON payload for contract creation.
 * @param body Raw request body.
 * @returns A normalized create-contract payload.
 */
export function validateCreateContractBody(body: unknown): CreateContractInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Contract payload must be a JSON object.');
  }

  const {
    title,
    clientId,
    freelancerId,
    budget,
    currency,
  } = body as Partial<CreateContractInput>;

  if (!title || !clientId || !freelancerId || typeof budget !== 'number' || !currency) {
    throw new ApiError(
      400,
      'title, clientId, freelancerId, budget, and currency are required.',
    );
  }

  if (!Number.isFinite(budget) || budget <= 0) {
    throw new ApiError(400, 'budget must be a positive number.');
  }

  return {
    title,
    clientId,
    freelancerId,
    budget,
    currency,
  };
}
