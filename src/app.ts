import express, { type Express } from 'express';

import { InMemoryCache } from './cache/in-memory-cache';
import { loadCacheConfig, type CacheConfig } from './config/cache-config';
import { errorMiddleware, notFoundMiddleware } from './middleware/error-middleware';
import { createContractRouter } from './routes/contract-routes';
import { createHealthRouter } from './routes/health-routes';
import { CachedContractService } from './services/cached-contract-service';
import { ContractService, type ContractServicePort } from './services/contract-service';
import type { ContractRecord } from './types/contract';
import type { CacheStore } from './cache/cache-store';

/**
 * @notice Application factory used by both production startup and integration tests.
 * @param options Optional app dependencies and test-only switches.
 */
export function createApp(options?: {
  seedContracts?: ContractRecord[];
  enableTestRoutes?: boolean;
  contractService?: ContractServicePort;
  cacheStore?: CacheStore;
  cacheConfig?: CacheConfig;
}): Express {
  const app = express();
  const cacheConfig = options?.cacheConfig ?? loadCacheConfig();
  const baseContractService =
    options?.contractService ?? new ContractService(options?.seedContracts ?? []);
  const cacheStore =
    options?.cacheStore ?? new InMemoryCache({ maxItems: cacheConfig.maxItems });
  const contractService = new CachedContractService(
    baseContractService,
    cacheStore,
    cacheConfig,
  );

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
