import { Router } from 'express';
import { ContractsController } from '../controllers/contracts.controller';
import { validateSchema } from '../middleware/validate.middleware';
import { createContractSchema, updateContractSchema } from '../modules/contracts/dto/contract.dto';

const router = Router();

router.get('/bounds', ContractsController.getBounds);
router.get('/stats', ContractsController.getContractStats);
router.get('/', ContractsController.getContracts);
router.get('/:id', ContractsController.getContractById);

router.post(
  '/',
  validateSchema(createContractSchema),
  ContractsController.createContract,
);

router.patch('/:id', validateSchema(updateContractSchema), ContractsController.updateContract);

router.delete('/:id', ContractsController.deleteContract);

export default router;
