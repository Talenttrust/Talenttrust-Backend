import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { config, explorerUrl } from './config';
import { EscrowStore, HttpError } from './store';
import { openapi, docsHtml } from './openapi';
import { parseFieldSpec, project } from './utils/project';
import { createLogger, type Logger, randomUUID } from './logger';
import { ChainReader, SorobanRpcChainReader } from './chain';
import { bigIntReplacer } from './amount';

declare global {
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}
import { idempotency, IdempotencyStore, MemoryIdempotencyStore } from './idempotency';

const startedAt = Date.now();

type LoggerLevel = 'debug' | 'info' | 'warn' | 'error';

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const wrap = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) {
      // Use bigIntReplacer so bigint amounts serialise as decimal strings
      // and JSON.stringify never throws on a response. Go through res.json so
      // middleware that wraps it (idempotency replay) still sees the body.
      res.json(JSON.parse(JSON.stringify(out, bigIntReplacer)));
    }
  } catch (err) {
    next(err);
  }
};

const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid_id', 'id must be a positive integer');
  return n;
};

const optionalString = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

/**
 * Parse the `?fields=` query param.  Returns `null` when the param is absent
 * (meaning "return all fields").  Throws {@link HttpError} 400 on invalid input.
 */
function parseFields(req: Request) {
  const raw = req.query.fields;
  if (typeof raw !== 'string') return null;
  return parseFieldSpec(raw);
}

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

export interface AppOptions {
  idempotencyStore?: IdempotencyStore;
  idempotencyRequired?: boolean;
}

export function createApp(
  storeOrOpts: EscrowStore | { logger?: Logger; store?: EscrowStore; chainReader?: ChainReader } = new EscrowStore().seed(),
  fallbackChainReader?: ChainReader,
  options: AppOptions = {},
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

  // Compression middleware: gzip/br for JSON responses ≥ 1 KB.
  // Excluded for text/event-stream and when Cache-Control: no-transform is set.
  app.use(
    compression({
      threshold: 1024, // bytes — skip compression for small responses
      filter(req, res) {
        // Honour Cache-Control: no-transform (RFC 7234 §5.2.1.6)
        const cc = res.getHeader('Cache-Control');
        if (typeof cc === 'string' && cc.includes('no-transform')) return false;
        // Never compress streaming responses
        const ct = res.getHeader('Content-Type');
        if (typeof ct === 'string' && ct.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );

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
        'PATCH /api/v1/contracts/:id',
        'DELETE /api/v1/contracts/:id',
        'GET  /api/v1/contracts/:id/revisions',
        'POST /api/v1/contracts/:id/deposit',
        'POST /api/v1/contracts/:id/milestones/:index/release',
        'POST /api/v1/contracts/:id/dispute',
        'POST /api/v1/contracts/:id/resolve',
        'POST /api/v1/contracts/:id/cancel',
        'POST /api/v1/contracts/:id/reputation',
        'POST /api/v1/contracts/:id/reviews',
        'POST /api/v1/contracts/:id/link',
        'GET  /api/v1/contracts/:id/parity',
        'GET  /api/v1/reputation/:address',
        'GET  /api/v1/reputation/:address/reviews',
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
  v1.use(
    idempotency(options.idempotencyStore ?? new MemoryIdempotencyStore(), {
      required: options.idempotencyRequired ?? process.env.IDEMPOTENCY_REQUIRED === 'true',
    }),
  );
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
      const spec = parseFields(req);
      const contracts = store.list({
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        party: typeof req.query.party === 'string' ? req.query.party : undefined,
        linked,
      });
      return { data: contracts.map((c) => project(c, spec)) };
    }),
  );
  v1.post(
    '/contracts',
    wrap((req, res) => {
      res.status(201).json(store.create(req.body ?? {}));
    }),
  );
  v1.get(
    '/contracts/:id',
    wrap((req) => project(store.get(id(req)), parseFields(req))),
  );
  v1.patch('/contracts/:id', wrap((req) => store.edit(id(req), req.body ?? {})));
  v1.delete(
    '/contracts/:id',
    wrap((req, res) => {
      store.delete(id(req), req.body?.client);
      res.status(204).end();
    }),
  );
  v1.get('/contracts/:id/revisions', wrap((req) => store.getRevisions(id(req))));
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
    '/contracts/:id/reviews',
    wrap((req, res) => {
      res.status(201).json(store.createReview(id(req), req.body ?? {}));
    }),
  );
  v1.post(
    '/contracts/:id/link',
    wrap(async (req) => store.linkEscrow(id(req), req.body?.escrowId, chainReader)),
  );
  v1.get(
    '/contracts/:id/parity',
    wrap(async (req) => store.checkParity(id(req), chainReader)),
  );
  v1.get('/reputation/:address', wrap((req) => store.getReputationWithClient(req.params.address)));
  v1.get(
    '/reputation/:address/reviews',
    wrap((req) => {
      const limitRaw = req.query.limit;
      const limit = typeof limitRaw === 'string' ? Number(limitRaw) : undefined;
      const cursorRaw = req.query.cursor;
      const cursor = typeof cursorRaw === 'string' ? Number(cursorRaw) : undefined;
      return store.listReviews(req.params.address, {
        role: optionalString(req.query.role),
        limit: Number.isFinite(limit as number) ? (limit as number) : undefined,
        cursor: Number.isFinite(cursor as number) ? cursor : undefined,
      });
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
