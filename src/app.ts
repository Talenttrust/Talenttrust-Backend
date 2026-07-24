/**
 * @module app
 * @description Express application factory.
 *
 * Separates app configuration from server bootstrap so the app can be
 * imported in tests without binding to a port.
 *
 * @security
 *  - express.json() body parser is scoped to this app instance only.
 *  - All routes return JSON; no HTML rendering surface.
 *  - CORS and Helmet security headers are applied via applySecurityMiddleware.
 */

import express from 'express';
import { applySecurityMiddleware } from './middleware/security';
import { MetricsService } from './observability/metrics-service';
import { rateLimitStore } from './config/rateLimit';
import { notFoundHandler, errorHandler } from './middleware/errorHandlers';
import { healthRouter as legacyHealthRouter } from './routes/health';
import { healthRouter as readinessHealthRouter } from './health';
import { validateEnv } from './config/env.schema';
import { createRequestLimitsMiddleware } from './middleware/requestLimits';

import contractsModuleRouter from './routes/contracts.routes';
import eventsRouter from './routes/events.routes';
import { createMetricsRouter } from './routes/metrics.routes';
import { metricsAuthMiddleware } from './middleware/metricsAuth';

import reputationRouter from './routes/reputation.routes';
import apiKeysRouter from './routes/apiKeys.routes';
import configRouter from './routes/config.routes';
import dependencyScanRouter from './routes/dependency-scan.routes';
import { adminRouter } from './routes/admin.routes';
import { deployRouter } from './routes/deploy.routes';
import { webhookSubscriptionRouter } from './routes/webhook-subscription.routes';
import { requestIdMiddleware } from './middleware/requestId';
import { httpLoggerMiddleware } from './middleware/httpLogger';
import { ReputationService } from './services/reputation.service';
import { getDb } from './db/database';
// `eventIngestionService` is intentionally not imported here to avoid
// unused-symbol lint warnings in the app factory. Individual routes
// import the registry when they need to interact with event ingestion.

interface AppFactoryOptions {
  includeTerminalHandlers?: boolean;
}

export function attachTerminalHandlers(app: express.Application): void {
  // ── 404 handler ──────────────────────────────────────────────────────────
  app.use(notFoundHandler);

  // ── Global error handler ─────────────────────────────────────────────────
  app.use(errorHandler);
}

/**
 * Creates and configures the Express application.
 *
 * @returns Configured Express app instance (not yet listening).
 */
export function createApp(options?: AppFactoryOptions): express.Application {
  const includeTerminalHandlers = options?.includeTerminalHandlers ?? true;
  const env = validateEnv();
  const app = express();

  // ── Security Middleware ───────────────────────────────────────────────────
  applySecurityMiddleware(app, env.CORS_ALLOWED_ORIGINS);

  const metricsService = new MetricsService(
    process.env['SERVICE_NAME'] ?? 'talenttrust-backend',
    undefined,
    { httpRouteLabelLimit: env.HTTP_METRICS_ROUTE_LABEL_LIMIT },
  );

  // ── Middleware ────────────────────────────────────────────────────────────
  app.use(requestIdMiddleware);
  app.use(createRequestLimitsMiddleware());
  app.use(express.json());
  app.use(httpLoggerMiddleware);
  app.use(metricsService.trackHttpRequest.bind(metricsService));

  // ── Initialize Services ───────────────────────────────────────────────────
  // Initialize reputation service with database connection
  const db = getDb();
  ReputationService.initialize(db);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/health', legacyHealthRouter);
  app.use('/health', readinessHealthRouter);
  app.use('/api/config', configRouter);
  app.use('/api/v1', eventsRouter);
  app.use('/api/v1', apiKeysRouter);
  app.use('/api/v1/contracts', contractsModuleRouter);
  app.use('/api/v1/reputation', reputationRouter);
  app.use('/api/v1/dependency-scan', dependencyScanRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/admin/deploy', deployRouter);
  app.use('/api/v1/webhook-subscriptions', webhookSubscriptionRouter);
  app.use('/api/v1/metrics', metricsAuthMiddleware, createMetricsRouter(metricsService));

  if (includeTerminalHandlers) {
    attachTerminalHandlers(app);
  }

  // Harden the underlying HTTP server against malformed / smuggled requests.
  // When Node's HTTP parser rejects a request at the protocol layer — e.g. a
  // body larger than the declared Content-Length, or a chunked upload past the
  // size limit — close the socket instead of leaking Node's default bare
  // "400 Bad Request". This never fires for well-formed requests, so normal
  // routing and error handling are unaffected.
  const originalListen = app.listen.bind(app);
  (app as express.Application).listen = ((...args: Parameters<express.Application['listen']>) => {
    const server = (originalListen as (...a: unknown[]) => import('http').Server)(...args);
    server.on('clientError', (_err: Error, socket: import('net').Socket) => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
    return server;
  }) as express.Application['listen'];

  return app;
}

/** Shutdown handler for graceful termination. */
export function shutdownRateLimitStore(): void {
  if (rateLimitStore && typeof (rateLimitStore as any).destroy === 'function') {
    (rateLimitStore as any).destroy();
    console.log('[rateLimit] Store shutdown complete');
  }
}
