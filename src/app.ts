import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config, explorerUrl } from './config';
import { EscrowStore, HttpError, type Cursor, type QueryFilters } from './store';
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

const CURSOR_SECRET = process.env.CURSOR_SECRET || randomBytes(32).toString('base64url');
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

export function createApp(
  storeOrOpts: EscrowStore | { logger?: Logger; store?: EscrowStore; chainReader?: ChainReader } = new EscrowStore().seed(),
  fallbackChainReader?: ChainReader,
) {
  const resolved = resolveStoreAndLogger(storeOrOpts);
  const store = resolved.store;
  const logger = resolved.logger;
  const chainReader = fallbackChainReader ?? resolved.chainReader;

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
    wrap((req, res) => {
      const limit = parseLimit(req.query.limit);
      const sort = parseSortParam(req.query.sort);
      const after = parseCursorParam(req.query.cursor, sort);
      const filters = parseFilters(req.query);
      const result = store.query({ filters, sort, limit, after });
      res.json({ data: result.data, page: { limit, nextCursor: result.nextCursor ? serializeCursor(result.nextCursor) : null, hasMore: result.hasMore } });
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

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function parseLimit(v: unknown): number {
  if (v === undefined) return 20;
  const n = Number(typeof v === 'string' ? v : String(v));
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new HttpError(400, 'invalid_query', 'limit must be an integer between 1 and 100');
  }
  return n;
}

function parseSortParam(v: unknown): string {
  if (v === undefined) return '-createdAt';
  const s = typeof v === 'string' ? v : String(v);
  const field = s.startsWith('-') ? s.slice(1) : s;
  if (!['createdAt', 'updatedAt', 'totalAmount'].includes(field)) {
    throw new HttpError(400, 'invalid_query', 'invalid sort');
  }
  return s;
}

function parseCursorParam(cursor: unknown, sort: string): { sort: string; lastValue: string; lastId: number } | undefined {
  if (cursor === undefined || cursor === null || cursor === '') return undefined;
  const cursorStr = typeof cursor === 'string' ? cursor : String(cursor);
  const parts = cursorStr.split('.');
  if (parts.length !== 2) throw new HttpError(400, 'invalid_cursor', 'invalid cursor');
  const [payload, sig] = parts;
  let obj: { sort?: unknown; lastValue?: unknown; lastId?: unknown };
  try {
    obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'invalid cursor');
  }
  const expectedSig = createHmac('sha256', CURSOR_SECRET).update(payload).digest('base64url');
  if (!constantTimeEqual(sig, expectedSig)) throw new HttpError(400, 'invalid_cursor', 'invalid cursor');
  if (obj.sort !== sort) throw new HttpError(400, 'invalid_cursor', 'cursor sort does not match requested sort');
  return { sort: sort, lastValue: String(obj.lastValue ?? ''), lastId: Number(obj.lastId ?? 0) };
}

function parseFilters(q: Request['query']): QueryFilters {
  const f: QueryFilters = {};
  if (typeof q.status === 'string') {
    f.status = q.status.split(',').map((s) => s.trim()).filter(Boolean);
    for (const status of f.status) {
      if (!['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'].includes(status)) {
        throw new HttpError(400, 'invalid_query', 'invalid status');
      }
    }
  }
  if (typeof q.party === 'string') f.party = q.party;
  if (typeof q.role === 'string') {
    if (f.party === undefined) throw new HttpError(400, 'invalid_query', 'role requires party');
    if (q.role !== 'client' && q.role !== 'freelancer') throw new HttpError(400, 'invalid_query', 'invalid role');
    f.role = q.role;
  }
  if (typeof q.token === 'string') f.token = q.token;
  if (typeof q.createdAfter === 'string') f.createdAfter = q.createdAfter;
  if (typeof q.createdBefore === 'string') f.createdBefore = q.createdBefore;
  if (typeof q.linked === 'string') f.linked = q.linked === 'true';
  return f;
}

function serializeCursor(cursor: Cursor): string {
  const payload = Buffer.from(JSON.stringify({ sort: cursor.sort, lastValue: cursor.lastValue, lastId: cursor.lastId })).toString('base64url');
  const sig = createHmac('sha256', CURSOR_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export default createApp;
