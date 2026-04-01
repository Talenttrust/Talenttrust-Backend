import { Router } from 'express';
import { ContractsController } from '../controllers/contracts.controller';
import { validateSchema } from '../middleware/validate.middleware';
import { createContractSchema } from '../modules/contracts/dto/contract.dto';

const router = Router();

// Configure routes for the Contracts module
router.get('/', ContractsController.getContracts);

// Enforce Zod input validation on the POST route
router.post(
  '/', 
  validateSchema(createContractSchema), 
  ContractsController.createContract
);

export default router;
