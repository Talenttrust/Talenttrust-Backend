import express, { type Express } from 'express';

import { InMemoryCache } from './cache/in-memory-cache';
import { loadCacheConfig, type CacheConfig } from './config/cache-config';
import { loadWebhookConfig, type WebhookConfig } from './config/webhook-config';
import { errorMiddleware, notFoundMiddleware } from './middleware/error-middleware';
import { createContractRouter } from './routes/contract-routes';
import { createHealthRouter } from './routes/health-routes';
import { createWebhookRouter } from './routes/webhook-routes';
import { CachedContractService } from './services/cached-contract-service';
import { ContractService, type ContractServicePort } from './services/contract-service';
import { InMemoryWebhookDeliveryStore, type WebhookDeliveryStore } from './services/webhook-delivery-store';
import { WebhookSignatureService } from './services/webhook-signature-service';
import { InMemoryWebhookEventProcessor, WebhookService } from './services/webhook-service';
import type { ContractRecord } from './types/contract';
import type { CacheStore } from './cache/cache-store';
import type { WebhookEventProcessor } from './types/webhook';

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
  webhookConfig?: WebhookConfig;
  webhookDeliveryStore?: WebhookDeliveryStore;
  webhookEventProcessor?: WebhookEventProcessor;
}): Express {
  const app = express();
  const cacheConfig = options?.cacheConfig ?? loadCacheConfig();
  const webhookConfig = options?.webhookConfig ?? loadWebhookConfig();
  const baseContractService =
    options?.contractService ?? new ContractService(options?.seedContracts ?? []);
  const cacheStore =
    options?.cacheStore ?? new InMemoryCache({ maxItems: cacheConfig.maxItems });
  const contractService = new CachedContractService(
    baseContractService,
    cacheStore,
    cacheConfig,
  );
  const webhookDeliveryStore =
    options?.webhookDeliveryStore ??
    new InMemoryWebhookDeliveryStore(webhookConfig.maxAgeSeconds);
  const webhookEventProcessor =
    options?.webhookEventProcessor ?? new InMemoryWebhookEventProcessor();
  const webhookService = new WebhookService(webhookDeliveryStore, webhookEventProcessor);
  const webhookSignatureService = new WebhookSignatureService(webhookConfig);

  app.use(
    '/webhooks/blockchain',
    express.raw({ type: 'application/json', limit: webhookConfig.rawBodyLimit }),
  );
  app.use(
    createWebhookRouter(webhookConfig, webhookSignatureService, webhookService),
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
