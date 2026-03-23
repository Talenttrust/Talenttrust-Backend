import express, { type Express } from 'express';

import { errorMiddleware, notFoundMiddleware } from './middleware/error-middleware';
import { createContractRouter } from './routes/contract-routes';
import { createHealthRouter } from './routes/health-routes';
import { ContractService } from './services/contract-service';
import type { ContractRecord } from './types/contract';

/**
 * @notice Application factory used by both production startup and integration tests.
 * @param options Optional app dependencies and test-only switches.
 */
export function createApp(options?: {
  seedContracts?: ContractRecord[];
  enableTestRoutes?: boolean;
  contractService?: ContractService;
}): Express {
  const app = express();
  const contractService =
    options?.contractService ?? new ContractService(options?.seedContracts ?? []);

  app.use(express.json());
  app.use(createHealthRouter());
  app.use(createContractRouter(contractService));

  if (options?.enableTestRoutes) {
    app.get('/__test__/error', () => {
      throw new Error('Unexpected test failure');
    });
  }

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
