import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createHash, timingSafeEqual } from 'crypto';
import { config, explorerUrl } from './config';
import {
  DEFAULT_DISPUTE_LIMIT,
  DisputeSort,
  DisputeStatusFilter,
  EscrowStore,
  HttpError,
  MAX_DISPUTE_LIMIT,
  publicContract,
} from './store';
import { openapi, docsHtml } from './openapi';
import { createLogger, type Logger, randomUUID } from './logger';
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

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

/** Admin read authorization middleware. Returns 404 if ADMIN_READ_TOKEN is not configured, 401 if invalid/missing. */
function requireAdminRead(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_READ_TOKEN;
  if (!expected) {
    res.status(404).json({ error: 'admin_not_configured', message: 'Admin endpoints are not configured' });
    return;
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid admin bearer token' });
    return;
  }
  const token = auth.slice('Bearer '.length);
  // Use timing-safe comparison to prevent timing attacks
  const expectedBuf = Buffer.from(expected);
  const tokenBuf = Buffer.from(token);
  if (expectedBuf.length !== tokenBuf.length || !timingSafeEqual(expectedBuf, tokenBuf)) {
    res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid admin bearer token' });
    return;
  }
  next();
}

/** Validate and normalize dispute status filter. */
function disputeStatus(value: unknown): DisputeStatusFilter {
  if (value === undefined) return 'all';
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_status', 'status must be a single string value');
  if (value !== 'open' && value !== 'resolved' && value !== 'all') {
    throw new HttpError(400, 'invalid_status', "status must be one of 'open', 'resolved', 'all'");
  }
  return value;
}

/** Validate and normalize dispute sort order. */
function disputeSort(value: unknown): DisputeSort {
  if (value === undefined) return 'oldest';
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_sort', 'sort must be a single string value');
  if (value !== 'oldest' && value !== 'newest' && value !== 'value') {
    throw new HttpError(400, 'invalid_sort', "sort must be one of 'oldest', 'newest', 'value'");
  }
  return value;
}

/** Validate and normalize overdue filter. */
function disputeOverdue(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_overdue', 'overdue must be a single string value');
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new HttpError(400, 'invalid_overdue', "overdue must be 'true' or 'false'");
}

/** Validate and normalize limit parameter. */
function disputeLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_DISPUTE_LIMIT;
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_limit', 'limit must be a single string value');
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DISPUTE_LIMIT) {
    throw new HttpError(400, 'invalid_limit', `limit must be an integer between 1 and ${MAX_DISPUTE_LIMIT}`);
  }
  return n;
}

/** Current time provider for dispute handlers. Can be overridden in tests via createApp options. */
function now(): Date {
  return new Date();
}

function resolveStoreAndLogger(
  storeOrOpts: EscrowStore | { logger?: Logger; store?: EscrowStore; chainReader?: ChainReader; now?: () => Date } = new EscrowStore().seed(),
): { store: EscrowStore; logger: Logger; chainReader: ChainReader; now: () => Date } {
  if (
    storeOrOpts &&
    typeof storeOrOpts === 'object' &&
    'list' in storeOrOpts &&
    typeof (storeOrOpts as EscrowStore).list === 'function'
  ) {
    return { store: storeOrOpts as EscrowStore, logger: createLogger(), chainReader: new SorobanRpcChainReader(), now: () => new Date() };
  }
  const opts = (storeOrOpts as { logger?: Logger; store?: EscrowStore; chainReader?: ChainReader; now?: () => Date } | undefined) ?? {};
  return {
    store: opts.store ?? new EscrowStore().seed(),
    logger: opts.logger ?? createLogger(),
    chainReader: opts.chainReader ?? new SorobanRpcChainReader(),
    now: opts.now ?? (() => new Date()),
  };
}

export function createApp(
  storeOrOpts: EscrowStore | { logger?: Logger; store?: EscrowStore; chainReader?: ChainReader; now?: () => Date } = new EscrowStore().seed(),
  fallbackChainReader?: ChainReader,
) {
  const resolved = resolveStoreAndLogger(storeOrOpts);
  const store = resolved.store;
  const logger = resolved.logger;
  const chainReader = fallbackChainReader ?? resolved.chainReader;
  const nowFn = resolved.now;

  const app = express();
  app.disable('x-powered-by');
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

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  // Structured access log on response finish.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
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
        'GET  /api/v1/disputes (admin)',
        'GET  /api/v1/disputes/:contractId (admin)',
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
        }).map(publicContract),
      };
    }),
  );
  v1.post(
    '/contracts',
    wrap((req, res) => {
      res.status(201).json(publicContract(store.create(req.body ?? {})));
    }),
  );
  v1.get('/contracts/:id', wrap((req) => publicContract(store.get(id(req)))));
  v1.post('/contracts/:id/deposit', wrap((req) => publicContract(store.deposit(id(req), req.body?.amount))));
  v1.post(
    '/contracts/:id/milestones/:index/release',
    wrap((req) => publicContract(store.release(id(req), Number(req.params.index)))),
  );
  v1.post(
    '/contracts/:id/dispute',
    wrap((req) => publicContract(store.openDispute(id(req), req.body?.raisedBy, req.body?.reason))),
  );
  v1.post(
    '/contracts/:id/resolve',
    wrap((req) => publicContract(store.resolveDispute(id(req), req.body?.freelancerBps))),
  );
  v1.post('/contracts/:id/cancel', wrap((req) => publicContract(store.cancel(id(req)))));
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
  v1.get(
    '/disputes',
    requireAdminRead,
    wrap((req) => {
      const cursor = req.query.cursor;
      if (cursor !== undefined && typeof cursor !== 'string') {
        throw new HttpError(400, 'invalid_cursor', 'cursor must be a single string value');
      }
      return store.listDisputes({
        status: disputeStatus(req.query.status),
        sort: disputeSort(req.query.sort),
        overdueOnly: disputeOverdue(req.query.overdue),
        limit: disputeLimit(req.query.limit),
        cursor,
        now: nowFn(),
        slaHours: config.disputeSlaHours,
      });
    }),
  );
  v1.get(
    '/disputes/:contractId',
    requireAdminRead,
    wrap((req) => {
      const n = Number(req.params.contractId);
      if (!Number.isInteger(n) || n < 1) {
        throw new HttpError(400, 'invalid_id', 'contractId must be a positive integer');
      }
      return store.getDispute(n, nowFn(), config.disputeSlaHours);
    }),
  );
  app.use('/api/v1', v1);

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
