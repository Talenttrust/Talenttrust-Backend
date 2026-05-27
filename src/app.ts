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
import { healthRouter } from './routes/health';

import contractsModuleRouter from './routes/contracts.routes';

import reputationRouter from './routes/reputation.routes';
import configRouter from './routes/config.routes';
import dependencyScanRouter from './routes/dependency-scan.routes';
import { adminRouter } from './routes/admin.routes';
import { requestIdMiddleware } from './middleware/requestId';
import { httpLoggerMiddleware } from './middleware/httpLogger';
import { ReputationService } from './services/reputation.service';
import { getDb } from './db/database';

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
export function createApp(): express.Application {
  const app = express();

  // ── Security Middleware ───────────────────────────────────────────────────
  applySecurityMiddleware(app);

  const metricsService = new MetricsService(
    process.env['SERVICE_NAME'] ?? 'talenttrust-backend',
  );

  // ── Middleware ────────────────────────────────────────────────────────────
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(httpLoggerMiddleware);
  app.use(metricsService.trackHttpRequest.bind(metricsService));

  // ── Initialize Services ───────────────────────────────────────────────────
  // Initialize reputation service with database connection
  const db = getDb();
  ReputationService.initialize(db);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/health', healthRouter);
  app.use('/api/config', configRouter);
  app.use('/api/v1/contracts', contractsModuleRouter);
  app.use('/api/v1/reputation', reputationRouter);
  app.use('/api/v1/dependency-scan', dependencyScanRouter);
  app.use('/api/v1/admin', adminRouter);

  // ── 404 handler ──────────────────────────────────────────────────────────
  app.use(notFoundHandler);

  // ── Global error handler ─────────────────────────────────────────────────
  app.use(errorHandler);

  return app;
}

/** Shutdown handler for graceful termination. */
export function shutdownRateLimitStore(): void {
  if (rateLimitStore && typeof (rateLimitStore as any).destroy === 'function') {
    (rateLimitStore as any).destroy();
    console.log('[rateLimit] Store shutdown complete');
  }
}
