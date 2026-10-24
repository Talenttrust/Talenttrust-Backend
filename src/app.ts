import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import { config, explorerUrl } from './config';
import { EscrowStore, EscrowContract, HttpError } from './store';
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

export function getContractEtag(contract: { id: number; version: number }): string {
  return `"${contract.id}-${contract.version}"`;
}

export function getContractsListEtag(contracts: EscrowContract[], queryString: string = ''): string {
  const pairs = contracts.map((c) => `${c.id}:${c.version}`).join(',');
  const hash = crypto.createHash('sha1').update(`${pairs}?${queryString}`).digest('hex');
  return `"${hash}"`;
}

export class PreconditionFailedError extends HttpError {
  constructor(public currentEtag: string, public currentVersion: number) {
    super(412, 'precondition_failed', 'Precondition failed');
  }
}

export class PreconditionRequiredError extends HttpError {
  constructor() {
    super(428, 'precondition_required', 'If-Match header is required');
  }
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

export function createApp(
  storeOrOpts: EscrowStore | { logger?: Logger; store?: EscrowStore; chainReader?: ChainReader } = new EscrowStore().seed(),
  fallbackChainReader?: ChainReader,
) {
  const resolved = resolveStoreAndLogger(storeOrOpts);
  const store = resolved.store;
  const logger = resolved.logger;
  const chainReader = fallbackChainReader ?? resolved.chainReader;

  const app = express();
  app.set('etag', false);
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
    (req: Request, res: Response, next: NextFunction) => {
      try {
        let linked: boolean | undefined = undefined;
        if (req.query.linked === 'true') linked = true;
        else if (req.query.linked === 'false') linked = false;
        const contracts = store.list({
          status: typeof req.query.status === 'string' ? req.query.status : undefined,
          party: typeof req.query.party === 'string' ? req.query.party : undefined,
          linked,
        });
        const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
        const etag = getContractsListEtag(contracts, qs);
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'no-cache');

        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch) {
          const clientEtags = ifNoneMatch
            .split(',')
            .map((s) => s.trim())
            .map((s) => (s.startsWith('W/') ? s.slice(2) : s));
          if (clientEtags.includes(etag) || clientEtags.includes('*')) {
            res.status(304).end();
            return;
          }
        }

        res.json({ data: contracts });
      } catch (err) {
        next(err);
      }
    },
  );
  v1.post(
    '/contracts',
    wrap((req, res) => {
      const contract = store.create(req.body ?? {});
      res.setHeader('ETag', getContractEtag(contract));
      res.status(201).json(contract);
    }),
  );
  v1.get('/contracts/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const contract = store.get(id(req));
      const etag = getContractEtag(contract);
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'no-cache');

      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch) {
        const clientEtags = ifNoneMatch
          .split(',')
          .map((s) => s.trim())
          .map((s) => (s.startsWith('W/') ? s.slice(2) : s));
        if (clientEtags.includes(etag) || clientEtags.includes('*')) {
          res.status(304).end();
          return;
        }
      }

      res.json(contract);
    } catch (err) {
      next(err);
    }
  });

  // Concurrency check middleware for mutations on /contracts/:id/*
  const checkMutationPreconditions = (req: Request, res: Response, next: NextFunction) => {
    try {
      const contractId = id(req);
      const contract = store.get(contractId);
      const ifMatch = req.headers['if-match'];

      if (!ifMatch) {
        if (config.requireIfMatch || process.env.REQUIRE_IF_MATCH === 'true') {
          throw new PreconditionRequiredError();
        }
      } else {
        const currentEtag = getContractEtag(contract);
        const matchValues = ifMatch.split(',').map((s) => s.trim());
        const isMatch =
          matchValues.includes('*') ||
          matchValues.includes(currentEtag) ||
          matchValues.includes(`W/${currentEtag}`) ||
          matchValues.some((val) => (val.startsWith('W/') ? val.slice(2) : val) === currentEtag);

        if (!isMatch) {
          throw new PreconditionFailedError(currentEtag, contract.version);
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };

  v1.post(
    '/contracts/:id/deposit',
    checkMutationPreconditions,
    wrap((req, res) => {
      const updated = store.deposit(id(req), req.body?.amount);
      res.setHeader('ETag', getContractEtag(updated));
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/milestones/:index/release',
    checkMutationPreconditions,
    wrap((req, res) => {
      const updated = store.release(id(req), Number(req.params.index));
      res.setHeader('ETag', getContractEtag(updated));
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/dispute',
    checkMutationPreconditions,
    wrap((req, res) => {
      const updated = store.openDispute(id(req), req.body?.raisedBy, req.body?.reason);
      res.setHeader('ETag', getContractEtag(updated));
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/resolve',
    checkMutationPreconditions,
    wrap((req, res) => {
      const updated = store.resolveDispute(id(req), req.body?.freelancerBps);
      res.setHeader('ETag', getContractEtag(updated));
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/cancel',
    checkMutationPreconditions,
    wrap((req, res) => {
      const updated = store.cancel(id(req));
      res.setHeader('ETag', getContractEtag(updated));
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/reputation',
    checkMutationPreconditions,
    wrap((req, res) => {
      const rep = store.rate(id(req), req.body?.rating);
      const contract = store.get(id(req));
      res.setHeader('ETag', getContractEtag(contract));
      return rep;
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
  v1.get('/reputation/:address', wrap((req) => store.getReputation(req.params.address)));
  app.use('/api/v1', v1);

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}`, requestId: req.id, docs: '/docs' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = req.id;
    if (err instanceof PreconditionFailedError) {
      res.setHeader('ETag', err.currentEtag);
      res.status(412).json({
        error: err.code,
        message: err.message,
        currentVersion: err.currentVersion,
      });
      return;
    }
    if (err instanceof PreconditionRequiredError) {
      res.status(428).json({
        error: err.code,
        message: err.message,
      });
      return;
    }
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
