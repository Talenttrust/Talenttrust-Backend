/**
 * @module app
 * @description Express application factory.
 *
 * This factory is the single place where process-wide singletons are wired
 * into the HTTP stack, so it also owns the invariants that keep that state
 * consistent when the factory is called more than once and when the process
 * tears down:
 *
 * @invariant INV-1 — The metrics registry holds exactly one service per
 *   process. `createApp()` initialises it on first use and then reuses it.
 *   Re-creating it per call would leave routers bound to one instance while
 *   cache interceptors and other consumers of the global registry write to a
 *   different one, splitting every metric across two registries.
 *
 * @invariant INV-2 — The terminal 404/error pair is registered exactly once
 *   per application and is the last thing mounted. `notFoundHandler` ends the
 *   chain, so any layer mounted after it is silently unreachable.
 *
 * @invariant INV-3 — Every router is mounted on exactly one path. Routers that
 *   carry a rate limiter must not be mounted twice: a request that falls
 *   through the first mount would consume the limiter budget again on the
 *   second one.
 *
 * @invariant INV-4 — `shutdownRateLimitStore()` releases every rate-limit
 *   store this module owns exactly once and reports through the structured
 *   logger so teardown failures stay diagnosable.
 */

import express from 'express';
import { applySecurityMiddleware } from './middleware/security';
import { MetricsService } from './observability/metrics-service';
import { setMetricsService } from './observability/registry';
import { rateLimitStore, apiKeysRateLimitStore } from './config/rateLimit';
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
import reputationRouter from './routes/reputation.routes';
import authRouter from './routes/auth.routes';
import configRouter from './routes/config.routes';
import dependencyScanRouter from './routes/dependency-scan.routes';
import { adminRouter } from './routes/admin.routes';
import { deployRouter } from './routes/deploy.routes';
import rpcEventsRouter from './routes/rpcEvents.routes';
import { webhookSubscriptionRouter } from './routes/webhook-subscription.routes';
import { features } from './config/features';
import { requestIdMiddleware } from './middleware/requestId';
import { httpLoggerMiddleware } from './middleware/httpLogger';
import { ReputationService } from './services/reputation.service';
import { getDb } from './db/database';
import { requestContextMiddleware } from './context';
import { logger } from './logger';

interface AppFactoryOptions {
  includeTerminalHandlers?: boolean;
}

/** Applications that already have the terminal 404/error layers mounted (INV-2). */
const terminalHandlerApps = new WeakSet<express.Application>();

/**
 * Process-wide metrics service (INV-1). Stays `null` until the first
 * `createApp()` call initialises the global registry.
 */
let metricsServiceInstance: MetricsService | null = null;

/** Latches teardown so repeated shutdown signals report once (INV-4). */
let rateLimitStoresReleased = false;

type DestroyableStore = { destroy?: () => void };

/**
 * Returns the process-wide metrics service, creating it on first use.
 *
 * The instance is created once and then reused, so every app instance and the
 * global registry share a single set of collectors (INV-1). The first
 * successful call wins; later calls ignore their own environment so repeated
 * factory calls cannot fork the registry.
 *
 * @param httpRouteLabelLimit - Resolved route-label cardinality limit
 * @returns The shared metrics service instance
 */
function resolveMetricsService(httpRouteLabelLimit: number): MetricsService {
  if (metricsServiceInstance === null) {
    metricsServiceInstance = new MetricsService(
      process.env['SERVICE_NAME'] ?? 'talenttrust-backend',
      undefined,
      { httpRouteLabelLimit },
    );
    setMetricsService(metricsServiceInstance);
  }
  return metricsServiceInstance;
}

/**
 * Mounts the terminal not-found and error handlers (INV-2).
 *
 * These layers terminate the Express chain, so they must be the last layers
 * mounted on the application. Callers that still need to mount routes after
 * the factory runs must build the app with `includeTerminalHandlers: false`
 * and call this afterwards.
 *
 * Re-entrant: a second call for the same application is a no-op, so the pair
 * is never mounted twice and cannot shadow handlers added after it.
 *
 * @param app - Application to seal
 */
export function attachTerminalHandlers(app: express.Application): void {
  if (terminalHandlerApps.has(app)) {
    logger.warn('app_terminal_handlers_already_attached', {
      hint: 'attachTerminalHandlers is idempotent; the extra call was ignored',
    });
    return;
  }
  terminalHandlerApps.add(app);

  app.use(notFoundHandler);
  app.use(errorHandler);
}

/**
 * Creates the Express application with all routes and middleware wired.
 *
 * @param options - Factory options. Omitting it is equivalent to passing
 *                an empty object.
 * @returns The configured Express application.
 */
export function createApp(options?: AppFactoryOptions): express.Application {
  const includeTerminalHandlers = options?.includeTerminalHandlers ?? true;
  const env = validateEnv();
  const app = express();

  applySecurityMiddleware(app, env.CORS_ALLOWED_ORIGINS);

  const metricsService = resolveMetricsService(env.HTTP_METRICS_ROUTE_LABEL_LIMIT);

  app.use(requestIdMiddleware);
  app.use(requestContextMiddleware);
  app.use(createRequestLimitsMiddleware());
  app.use(express.json());
  app.use(httpLoggerMiddleware);
  app.use(metricsService.trackHttpRequest.bind(metricsService));

  const db = getDb();
  // Fire-and-forget initialization is safe here because ensureReputationInitialized
  // guarantees the underlying work runs at most once and concurrent callers share
  // the same in-flight promise. Errors are surfaced through the returned promise
  // and must not be swallowed silently.
  void ensureReputationInitialized(db).catch((err) => {
    console.error('[app] ReputationService initialization failed', err);
  });

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
  // INV-3: mounted once. `apiKeysRouter` carries a router-level rate limiter,
  // so a second mount would charge the API-key budget twice for every request
  // that falls through to it.
  app.use('/api/v1', apiKeysRouter);
  app.use('/api/v1/contracts', createContractsRouter(metricsService));
  app.use('/api/v1/disputes', createDisputesRouter({ metricsService }));
  app.use('/api/v1/reputation', reputationRouter);
  app.use('/api/v1/dependency-scan', dependencyScanRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/admin/deploy', deployRouter);
  app.use('/api/v1', rpcEventsRouter);
  if (features.webhooksEnabled) {
    mountRouter(app, '/api/v1/webhook-subscriptions', webhookSubscriptionRouter);
  }
  mountRouter(app, '/api/v1/metrics', metricsAuthMiddleware, createMetricsRouter(metricsService));

  if (includeTerminalHandlers) {
    attachTerminalHandlers(app);
  }

  // Installed after the layers above, but it registers no route: it only wraps
  // `listen` so every server this app owns drops malformed-request sockets
  // instead of letting Node's default handler echo a 400 back.
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

/**
 * Releases every rate-limit store this module owns (INV-4).
 *
 * The stores exported by `config/rateLimit` each hold a sweep timer, so leaving
 * them alive keeps in-memory counters around after the server has drained. The
 * `globalThis` entry is retained as a fallback for stores wired up outside this
 * module.
 *
 * Idempotent: the first call tears down and reports, later calls return
 * immediately so repeated shutdown signals do not re-log a completed teardown.
 */
export function shutdownRateLimitStore(): void {
  if (rateLimitStoresReleased) return;
  rateLimitStoresReleased = true;

  const candidates: Array<[string, DestroyableStore | undefined]> = [
    ['rate_limit_store', rateLimitStore],
    ['api_keys_rate_limit_store', apiKeysRateLimitStore],
    [
      'api_keys_rate_limit_store_global',
      (globalThis as unknown as Record<string, DestroyableStore | undefined>)[
        'apiKeysRateLimitStore'
      ],
    ],
  ];

  const released: string[] = [];
  const seen = new Set<DestroyableStore>();

  for (const [name, store] of candidates) {
    if (!store || typeof store.destroy !== 'function' || seen.has(store)) continue;
    seen.add(store);
    try {
      store.destroy();
      released.push(name);
    } catch (error) {
      logger.error('rate_limit_store_shutdown_failed', {
        store: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('rate_limit_stores_shutdown_complete', { stores: released });
}
