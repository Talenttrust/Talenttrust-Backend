import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { config, explorerUrl } from './config';
import { EscrowStore, HttpError } from './store';
import { openapi, docsHtml } from './openapi';
import { validate } from './validation/middleware';
import {
  IdParam,
  MilestoneIndexParam,
  MilestoneReleaseParams,
  CreateContractBody,
  DepositBody,
  DisputeBody,
  ResolveBody,
  RateBody,
  CancelBody,
  ListQuery,
  ReputationAddressParam,
} from './validation/schemas';
import { parseFieldSpec, project } from './utils/project';
import { createLogger, type Logger, randomUUID } from './logger';
import { ChainReader, SorobanRpcChainReader } from './chain';
import { buildEscrowTransaction, TxBuildError, type RpcClient } from './stellar/escrowTxBuilder';
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

/** Dependencies that can be injected via createApp's first argument. */
export type AppDeps = { logger?: Logger; store?: EscrowStore; chainReader?: ChainReader; txRpcServer?: RpcClient };

function resolveStoreAndLogger(
  storeOrOpts: EscrowStore | AppDeps = new EscrowStore().seed(),
): { store: EscrowStore; logger: Logger; chainReader: ChainReader; txRpcServer?: RpcClient } {
  if (
    storeOrOpts &&
    typeof storeOrOpts === 'object' &&
    'list' in storeOrOpts &&
    typeof (storeOrOpts as EscrowStore).list === 'function'
  ) {
    return { store: storeOrOpts as EscrowStore, logger: createLogger(), chainReader: new SorobanRpcChainReader() };
  }
  const opts = (storeOrOpts as AppDeps | undefined) ?? {};
  return {
    store: opts.store ?? new EscrowStore().seed(),
    logger: opts.logger ?? createLogger(),
    chainReader: opts.chainReader ?? new SorobanRpcChainReader(),
    txRpcServer: opts.txRpcServer,
  };
}

export interface AppOptions {
  idempotencyStore?: IdempotencyStore;
  idempotencyRequired?: boolean;
}

export function createApp(
  storeOrOpts: EscrowStore | AppDeps = new EscrowStore().seed(),
  fallbackChainReader?: ChainReader,
  options: AppOptions = {},
) {
  const resolved = resolveStoreAndLogger(storeOrOpts);
  const store = resolved.store;
  const logger = resolved.logger;
  const chainReader = fallbackChainReader ?? resolved.chainReader;
  const txRpcServer = resolved.txRpcServer;

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
        'POST /api/v1/tx/build',
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
  v1.post(
    '/tx/build',
    wrap(async (req) =>
      buildEscrowTransaction(req.body, txRpcServer ? { server: txRpcServer } : {}),
    ),
  );
  v1.get('/stats', wrap(() => store.stats()));
  v1.get(
    '/contracts',
    validate({ query: ListQuery }),
    wrap((req) => {
      let linked: boolean | undefined = undefined;
      if (req.query.linked === 'true') linked = true;
      else if (req.query.linked === 'false') linked = false;
      const spec = parseFields(req);
      const contracts = store.list({
        status: req.query.status as string | undefined,
        party: req.query.party as string | undefined,
        linked,
      });
      return { data: contracts.map((c) => project(c, spec)) };
    }),
  );
  v1.post(
    '/contracts',
    validate({ body: CreateContractBody }),
    wrap((req, res) => {
      res.status(201).json(store.create(req.body));
    }),
  );
  v1.get(
    '/contracts/:id',
    validate({ params: IdParam }),
    wrap((req) => project(store.get(Number(req.params.id)), parseFields(req))),
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
  v1.post(
    '/contracts/:id/deposit',
    validate({ params: IdParam, body: DepositBody }),
    wrap((req) => store.deposit(Number(req.params.id), req.body.amount)),
  );
  v1.post(
    '/contracts/:id/milestones/:index/release',
    validate({ params: MilestoneReleaseParams }),
    wrap((req) => store.release(Number(req.params.id), Number(req.params.index))),
  );
  v1.post(
    '/contracts/:id/dispute',
    validate({ params: IdParam, body: DisputeBody }),
    wrap((req) => store.openDispute(Number(req.params.id), req.body.raisedBy, req.body.reason)),
  );
  v1.post(
    '/contracts/:id/resolve',
    validate({ params: IdParam, body: ResolveBody }),
    wrap((req) => store.resolveDispute(Number(req.params.id), req.body.freelancerBps)),
  );
  v1.post(
    '/contracts/:id/cancel',
    validate({ params: IdParam, body: CancelBody }),
    wrap((req) => store.cancel(Number(req.params.id))),
  );
  v1.post(
    '/contracts/:id/reputation',
    validate({ params: IdParam, body: RateBody }),
    wrap((req) => store.rate(Number(req.params.id), req.body.rating)),
  );
  v1.get(
    '/reputation/:address',
    validate({ params: ReputationAddressParam }),
    wrap((req) => store.getReputationWithClient(req.params.address)),
  );
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
    if (err instanceof TxBuildError) {
      res
        .status(err.status)
        .json({
          error: err.code,
          message: err.message,
          ...(err.contractError ? { contractError: err.contractError } : {}),
          requestId,
        });
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