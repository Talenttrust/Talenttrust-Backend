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
import { contractsRouter } from './routes/contracts';

/**
 * Creates and configures the Express application.
 *
 * @returns Configured Express app instance (not yet listening).
 */
export function createApp(): express.Application {
  const app = express();

  // ── Middleware ────────────────────────────────────────────────────────────
  app.use(express.json());

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/health', healthRouter);
  app.use('/api/v1/contracts', contractsRouter);

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
