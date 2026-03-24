/**
 * @module index
 * @description TalentTrust API entry point.
 *
 * Initialises the Express application, connects to the database,
 * runs pending migrations on startup, and registers all route handlers.
 *
 * ## Startup sequence
 * 1. Validate required environment variables.
 * 2. Run pending database migrations (idempotent).
 * 3. Start the HTTP server.
 *
 * ## Security Notes
 * - The /admin/migrate and /admin/seed endpoints require the
 *   ADMIN_SECRET header to match the ADMIN_SECRET env variable.
 * - These endpoints must be firewalled from public access in production.
 */

import express, { Request, Response, NextFunction } from 'express';
import { runMigrations, getMigrationStatus } from './db/migrator';
import { runSeeds, getSeedStatus } from './db/seeder';
import { closePool } from './db/connection';

export const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// ============================================================================
// Middleware — Admin auth guard
// ============================================================================

/**
 * Simple shared-secret guard for admin endpoints.
 * In production this should be replaced with a proper auth layer.
 */
function requireAdminSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'Admin endpoints are not configured' });
    return;
  }
  if (req.headers['x-admin-secret'] !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ============================================================================
// Health
// ============================================================================

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'talenttrust-backend' });
});

// ============================================================================
// Contracts (stub — will be replaced by real handlers)
// ============================================================================

app.get('/api/v1/contracts', (_req: Request, res: Response) => {
  res.json({ contracts: [] });
});

// ============================================================================
// Admin — Migration management
// ============================================================================

/**
 * GET /admin/migrations
 * Returns the list of applied migrations.
 *
 * @security Requires X-Admin-Secret header.
 */
app.get('/admin/migrations', requireAdminSecret, async (_req: Request, res: Response) => {
  try {
    const status = await getMigrationStatus();
    res.json({ migrations: status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /admin/migrations/run
 * Runs all pending migrations.
 *
 * @security Requires X-Admin-Secret header.
 */
app.post('/admin/migrations/run', requireAdminSecret, async (_req: Request, res: Response) => {
  try {
    const applied = await runMigrations({ verbose: false });
    res.json({ applied });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ============================================================================
// Admin — Seed management
// ============================================================================

/**
 * GET /admin/seeds
 * Returns the list of applied seeds.
 *
 * @security Requires X-Admin-Secret header.
 */
app.get('/admin/seeds', requireAdminSecret, async (_req: Request, res: Response) => {
  try {
    const status = await getSeedStatus();
    res.json({ seeds: status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /admin/seeds/run
 * Runs all pending seeds for the current environment.
 *
 * @security Requires X-Admin-Secret header.
 */
app.post('/admin/seeds/run', requireAdminSecret, async (_req: Request, res: Response) => {
  try {
    const applied = await runSeeds({ verbose: false });
    res.json({ applied });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ============================================================================
// Server bootstrap
// ============================================================================

/* istanbul ignore next */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`TalentTrust API listening on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('Shutting down...');
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
