import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createHmac, randomBytes } from 'node:crypto';
import { config, explorerUrl } from './config';
import { EscrowStore, HttpError } from './store';
import { openapi, docsHtml } from './openapi';
import { createLogger, type Logger, randomUUID } from './logger';
import {
  createRegistry,
  type Registry,
  HTTP_DURATION_BUCKETS,
  constantTimeEqual,
} from './metrics';
import { ChainReader, SorobanRpcChainReader } from './chain';

declare global {
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

const startedAt = Date.now();

type LoggerLevel = 'debug' | 'info' | 'warn' | 'error';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

const CURSOR_SECRET = process.env.CURSOR_SECRET || randomBytes(32).toString('base64url');

function resolveStoreAndLogger(
  storeOrOpts: EscrowStore | { logger?: Logger; store?: EscrowStore; chainReader?: ChainReader } = new EscrowStore().seed(),
): { store: EscrowStore; logger: Logger; chainReader: ChainReader } {
  if (
    storeOrOpts &&
    typeof storeOrOpts === 'object' &&
    'list' in storeOrOpts &&
    typeof (storeOrOpts as EscrowStore).list === 'function'
  ) {
    return { store: storeOrOpts as EscrowStore, logger: createLogger(), chainReader: new SorobanRpcChainReader() };
  }
  const opts = (storeOrOpts as { logger?: Logger; store?: EscrowStore; chainReader?: ChainReader } | undefined) ?? {};
  return {
    store: opts.store ?? new EscrowStore().seed(),
    logger: opts.logger ?? createLogger(),
    chainReader: opts.chainReader ?? new SorobanRpcChainReader(),
  };
}

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const wrap = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    next(err);
  }
};

const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid_id', 'id must be a positive integer');
  return n;
};

export function createApp(
  storeOrOpts: EscrowStore | { logger?: Logger; store?: EscrowStore; chainReader?: ChainReader } = new EscrowStore().seed(),
  opts: { registry?: Registry } = {},
  fallbackChainReader?: ChainReader,
) {
  const resolved = resolveStoreAndLogger(storeOrOpts);
  const store = resolved.store;
  const logger = resolved.logger;
  const chainReader = fallbackChainReader ?? resolved.chainReader;
  const registry = opts.registry ?? createRegistry();
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  // Correlation id: echo a valid inbound X-Request-Id, otherwise generate one.
  // The regex excludes CR/LF so a client cannot inject log-line terminators.
  app.use((req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const value = Array.isArray(incoming) ? incoming[0] : incoming;
    const requestId = value && REQUEST_ID_RE.test(value) ? (value as string) : randomUUID();
    req.id = requestId;
    res.set('X-Request-Id', requestId);
    next();
  });

  // HTTP RED metrics: request counter and latency histogram.
  const httpRequestsTotal = registry.counter(
    'http_requests_total',
    'Total number of HTTP requests',
    ['method', 'route', 'status'],
  );
  const httpRequestDuration = registry.histogram(
    'http_request_duration_seconds',
    'HTTP request duration in seconds',
    ['method', 'route'],
    HTTP_DURATION_BUCKETS,
  );

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const durationSeconds = (Date.now() - start) / 1000;
      const route = req.route ? String(req.baseUrl || '') + String(req.route.path || '') : 'unmatched';
      httpRequestsTotal.inc({ method: req.method, route, status: String(res.statusCode) });
      httpRequestDuration.observe({ method: req.method, route }, durationSeconds);
    });
    next();
  });

  // Structured access log on response finish.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      const route = req.route ? String(req.baseUrl || '') + String(req.route.path || '') : 'unmatched';
      let level: LoggerLevel = 'info';
      if (res.statusCode >= 500) level = 'error';
      else if (res.statusCode >= 429) level = 'warn';
      logger[level]('request', {
        method: req.method,
        path: route,
        status: res.statusCode,
        durationMs,
        contentLength: res.get('content-length') ?? undefined,
        ip: req.ip,
      });
    });
    next();
  });

  // Domain mutation counter: incremented in the store layer.
  const escrowMutationsTotal = registry.counter(
    'escrow_mutations_total',
    'Total number of escrow mutations',
    ['action', 'result'],
  );
  store.setMutationRecorder((action, result) => escrowMutationsTotal.inc({ action, result }));

  app.get(
    '/',
    wrap(() => ({
      name: 'TalentTrust API',
      version: config.version,
      description: 'Milestone-based freelancer escrow API backed by a Soroban contract on Stellar.',
      docs: '/docs',
      openapi: '/openapi.json',
      website: config.frontendUrl,
      chain: { network: config.network, contractId: config.contractId, explorer: explorerUrl() },
      endpoints: [
        'GET  /health',
        'GET  /docs',
        'GET  /openapi.json',
        'GET  /api/v1/chain',
        'GET  /api/v1/stats',
        'GET  /api/v1/contracts',
        'POST /api/v1/contracts',
        'GET  /api/v1/contracts/:id',
        'POST /api/v1/contracts/:id/deposit',
        'POST /api/v1/contracts/:id/milestones/:index/release',
        'POST /api/v1/contracts/:id/dispute',
        'POST /api/v1/contracts/:id/resolve',
        'POST /api/v1/contracts/:id/cancel',
        'POST /api/v1/contracts/:id/reputation',
        'POST /api/v1/contracts/:id/link',
        'GET  /api/v1/contracts/:id/parity',
        'GET  /api/v1/reputation/:address',
      ],
    })),
  );

  app.get('/health', (req, res) => {
    if (app.get('draining')) {
      res.status(503).setHeader('Connection', 'close').json({ status: 'draining' });
      return;
    }
    res.json({
      status: 'ok',
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      storage: 'in-memory',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/openapi.json', wrap(() => openapi));
  app.get(['/docs', '/docs/'], (_req, res) => {
    res.type('html').send(docsHtml);
  });

  const v1 = express.Router();
  v1.get(
    '/chain',
    wrap(() => ({
      network: config.network,
      rpcUrl: config.rpcUrl,
      contractId: config.contractId,
      explorer: explorerUrl(),
    })),
  );
  v1.get('/stats', wrap(() => store.stats()));
  v1.get(
    '/contracts',
    wrap((req) => {
      let linked: boolean | undefined = undefined;
      if (req.query.linked === 'true') linked = true;
      else if (req.query.linked === 'false') linked = false;
      return {
        data: store.list({
          status: typeof req.query.status === 'string' ? req.query.status : undefined,
          party: typeof req.query.party === 'string' ? req.query.party : undefined,
          linked,
        }),
      };
    }),
  );
  v1.post(
    '/contracts',
    wrap((req, res) => {
      res.status(201).json(store.create(req.body ?? {}));
    }),
  );
  v1.get('/contracts/:id', wrap((req) => store.get(id(req))));
  v1.post('/contracts/:id/deposit', wrap((req) => store.deposit(id(req), req.body?.amount)));
  v1.post(
    '/contracts/:id/milestones/:index/release',
    wrap((req) => store.release(id(req), Number(req.params.index))),
  );
  v1.post(
    '/contracts/:id/dispute',
    wrap((req) => store.openDispute(id(req), req.body?.raisedBy, req.body?.reason)),
  );
  v1.post('/contracts/:id/resolve', wrap((req) => store.resolveDispute(id(req), req.body?.freelancerBps)));
  v1.post('/contracts/:id/cancel', wrap((req) => store.cancel(id(req))));
  v1.post('/contracts/:id/reputation', wrap((req) => store.rate(id(req), req.body?.rating)));
  v1.post(
    '/contracts/:id/link',
    wrap(async (req) => store.linkEscrow(id(req), req.body?.escrowId, chainReader)),
  );
  v1.get(
    '/contracts/:id/parity',
    wrap(async (req) => store.checkParity(id(req), chainReader)),
  );
  v1.get('/reputation/:address', wrap((req) => store.getReputation(req.params.address)));
  app.use('/api/v1', v1);

  // /metrics is disabled (404) when METRICS_TOKEN is unset; checked at request time.
  const escrowContracts = registry.gauge('escrow_contracts', 'Escrow contracts by status', ['status']);
  const escrowValueEscrowed = registry.gauge('escrow_value_escrowed', 'Value currently escrowed', []);
  const escrowValueReleased = registry.gauge('escrow_value_released', 'Value released', []);
  const processUptime = registry.gauge('process_uptime_seconds', 'Process uptime in seconds', []);
  const nodejsHeapUsed = registry.gauge('nodejs_heap_used_bytes', 'Node.js heap used in bytes', []);

  app.get('/metrics', (req, res) => {
    if (!process.env.METRICS_TOKEN) {
      res.status(404).json({ error: 'not_found', message: 'Metrics endpoint disabled' });
      return;
    }
    const auth = req.headers['authorization'];
    const provided = Array.isArray(auth) ? auth[0] : auth;
    const expected = 'Bearer ' + process.env.METRICS_TOKEN!;
    if (!provided || !constantTimeEqual(provided, expected)) {
      res.status(401).json({ error: 'unauthorized', message: 'Invalid metrics token' });
      return;
    }
    const stats = store.stats();
    for (const [status, count] of Object.entries(stats.byStatus)) {
      escrowContracts.set({ status }, count);
    }
    escrowValueEscrowed.set({}, stats.totalEscrowed);
    escrowValueReleased.set({}, stats.totalReleased);
    processUptime.set({}, process.uptime());
    nodejsHeapUsed.set({}, process.memoryUsage().heapUsed);
    res.type('text/plain; version=0.0.4').send(registry.exposition());
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}`, requestId: req.id, docs: '/docs' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = req.id;
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, ...err.details, requestId });
      return;
    }
    if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'Malformed JSON body', requestId });
      return;
    }
    logger.error('unhandled_error', {
      requestId,
      err: {
        name: (err as Error)?.name ?? 'Error',
        message: (err as Error)?.message ?? String(err),
        stack: (err as Error)?.stack,
      },
    });
    res.status(500).json({ error: 'internal_error', message: 'Unexpected error', requestId });
  });

  return app;
}

export default createApp;
