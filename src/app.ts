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
 *  - Helmet-style headers should be added here when the dependency is
 *    introduced (tracked in docs/backend/security.md).
 */

import express, { Request, Response, NextFunction } from 'express';
import { healthRouter } from './routes/health';
import contractsModuleRouter from './routes/contracts.routes';
import reputationRouter from './routes/reputation.routes';
import { requestIdMiddleware } from './middleware/requestId';
import { apiVersionMiddleware } from './middleware/apiVersion';

/**
 * Creates and configures the Express application.
 *
 * @returns Configured Express app instance (not yet listening).
 */
export function createApp(): express.Application {
  const app = express();

  // ── Middleware ────────────────────────────────────────────────────────────
  app.use(express.json());
  app.use(requestIdMiddleware);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/health', healthRouter);

  // v1 – deprecated; sunset 2026-11-01. Clients should migrate to /api/v2.
  app.use('/api/v1', apiVersionMiddleware('v1'));
  app.use('/api/v1/contracts', contractsModuleRouter);
  app.use('/api/v1/reputation', reputationRouter);

  // v2 – current stable version.
  app.use('/api/v2', apiVersionMiddleware('v2'));
  app.use('/api/v2/contracts', contractsModuleRouter);
  app.use('/api/v2/reputation', reputationRouter);

  // ── 404 handler ──────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // ── Global error handler ─────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}
