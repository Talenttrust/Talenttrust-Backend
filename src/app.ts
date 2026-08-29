import express from 'express';
import { applySecurityMiddleware } from './middleware/security';
import { MetricsService } from './observability/metrics-service';
import { setMetricsService } from './observability/registry';
import { rateLimitStore } from './config/rateLimit';
import { notFoundHandler, errorHandler } from './middleware/errorHandlers';
import { healthRouter as legacyHealthRouter } from './routes/health';
import { healthRouter as readinessHealthRouter } from './health';
import { validateEnv } from './config/env.schema';
import { createRequestLimitsMiddleware } from './middleware/requestLimits';
import apiKeysRouter from './routes/apiKeys.routes';
import { createContractsRouter } from './routes/contracts.routes';
import eventsRouter from './routes/events.routes';
import { createDisputesRouter } from './routes/disputes.routes';
import { createMetricsRouter } from './routes/metrics.routes';
import { metricsAuthMiddleware } from './middleware/metricsAuth';
import reputationRouter, { createReputationRouter } from './routes/reputation.routes';
import authRouter from './routes/auth.routes';
import configRouter from './routes/config.routes';
import dependencyScanRouter from './routes/dependency-scan.routes';
import { adminRouter } from './routes/admin.routes';
import { deployRouter } from './routes/deploy.routes';
import { webhookSubscriptionRouter } from './routes/webhook-subscription.routes';
import { features } from './config/features';
import { requestIdMiddleware } from './middleware/requestId';
import { httpLoggerMiddleware } from './middleware/httpLogger';
import { ReputationService } from './services/reputation.service';
import { getDb } from './db/database';
import { requestContextMiddleware } from './context';

interface AppFactoryOptions {
  includeTerminalHandlers?: boolean;
}

export function attachTerminalHandlers(app: express.Application): void {
  app.use(notFoundHandler);
  app.use(errorHandler);
}

export function createApp(options?: AppFactoryOptions): express.Application {
  const includeTerminalHandlers = options?.includeTerminalHandlers ?? true;
  const env = validateEnv();
  const app = express();

  applySecurityMiddleware(app, env.CORS_ALLOWED_ORIGINS);

  const metricsService = new MetricsService(
    process.env['SERVICE_NAME'] ?? 'talenttrust-backend',
    undefined,
    { httpRouteLabelLimit: env.HTTP_METRICS_ROUTE_LABEL_LIMIT },
  );

  setMetricsService(metricsService);

  app.use(requestIdMiddleware);
  app.use(requestContextMiddleware);
  app.use(createRequestLimitsMiddleware());
  app.use(express.json());
  app.use(httpLoggerMiddleware);
  app.use(metricsService.trackHttpRequest.bind(metricsService));

  const db = getDb();
  ReputationService.initialize(db);

  app.get('/metrics', metricsAuthMiddleware, async (_req, res) => {
    res.setHeader('Content-Type', metricsService.contentType);
    res.status(200).send(await metricsService.getMetrics());
  });

  app.use('/health', legacyHealthRouter);
  app.use('/health', readinessHealthRouter);
  app.use('/api/config', configRouter);
  app.use('/api/v1', eventsRouter);
  app.use('/api/v1/auth', metricsService.trackAuthRequest.bind(metricsService));
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/api-keys', metricsService.trackApiKeysRequest.bind(metricsService));
  app.use('/api/v1', apiKeysRouter);
  app.use('/api/v1/contracts', createContractsRouter(metricsService));
  app.use('/api/v1/disputes', createDisputesRouter({ metricsService }));
  app.use('/api/v1/reputation', reputationRouter);
  app.use('/api/v1/dependency-scan', dependencyScanRouter);
  app.use('/api/v1', apiKeysRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/admin/deploy', deployRouter);
  if (features.webhooksEnabled) {
    app.use('/api/v1/webhook-subscriptions', webhookSubscriptionRouter);
  }
  app.use('/api/v1/metrics', metricsAuthMiddleware, createMetricsRouter(metricsService));

  if (includeTerminalHandlers) {
    attachTerminalHandlers(app);
  }

  const originalListen = app.listen.bind(app);
  (app as express.Application).listen = ((...args: Parameters<express.Application['listen']>) => {
    const server = (originalListen as (...a: unknown[]) => import('http').Server)(...args);
    server.on('clientError', (_err: Error, socket: import('net').Socket) => {
      if (!socket.destroyed) socket.destroy();
    });
    return server;
  }) as express.Application['listen'];

  return app;
}

export function shutdownRateLimitStore(): void {
  if (rateLimitStore && typeof (rateLimitStore as any).destroy === 'function') {
    (rateLimitStore as any).destroy();
    console.log('[rateLimit] Store shutdown complete');
  }
  if (typeof (globalThis as any).apiKeysRateLimitStore?.destroy === 'function') {
    (globalThis as any).apiKeysRateLimitStore.destroy();
    console.log('[rateLimit] API-key store shutdown complete');
  }
}
