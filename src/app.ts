import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, explorerUrl } from './config';
import { EscrowStore, HttpError } from './store';
import { openapi, docsHtml } from './openapi';
import { createLogger, type Logger, randomUUID } from './logger';
import { ChainReader, SorobanRpcChainReader } from './chain';
import { ReceiptManager, hashContractState, verifyReceipt } from './receipts';

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

function resolveStoreAndLogger(
  storeOrOpts: EscrowStore | { logger?: Logger; store?: EscrowStore; chainReader?: ChainReader; receiptManager?: ReceiptManager } = new EscrowStore().seed(),
): { store: EscrowStore; logger: Logger; chainReader: ChainReader; receiptManager?: ReceiptManager } {
  if (
    storeOrOpts &&
    typeof storeOrOpts === 'object' &&
    'list' in storeOrOpts &&
    typeof (storeOrOpts as EscrowStore).list === 'function'
  ) {
    return { store: storeOrOpts as EscrowStore, logger: createLogger(), chainReader: new SorobanRpcChainReader() };
  }
  const opts = (storeOrOpts as { logger?: Logger; store?: EscrowStore; chainReader?: ChainReader; receiptManager?: ReceiptManager } | undefined) ?? {};
  return {
    store: opts.store ?? new EscrowStore().seed(),
    logger: opts.logger ?? createLogger(),
    chainReader: opts.chainReader ?? new SorobanRpcChainReader(),
    receiptManager: opts.receiptManager,
  };
}

export function createApp(
  storeOrOpts: EscrowStore | { logger?: Logger; store?: EscrowStore; chainReader?: ChainReader; receiptManager?: ReceiptManager } = new EscrowStore().seed(),
  fallbackChainReaderOrReceiptManager?: ChainReader | ReceiptManager,
  fallbackReceiptManager?: ReceiptManager,
) {
  const resolved = resolveStoreAndLogger(storeOrOpts);
  const store = resolved.store;
  const logger = resolved.logger;

  let chainReader: ChainReader;
  let receiptManager: ReceiptManager;

  if (fallbackChainReaderOrReceiptManager instanceof ReceiptManager) {
    chainReader = resolved.chainReader;
    receiptManager = fallbackChainReaderOrReceiptManager;
  } else if (fallbackChainReaderOrReceiptManager) {
    chainReader = fallbackChainReaderOrReceiptManager;
    receiptManager = fallbackReceiptManager ?? resolved.receiptManager ?? new ReceiptManager(process.env.RECEIPT_SIGNING_SECRET);
  } else {
    chainReader = resolved.chainReader;
    receiptManager = fallbackReceiptManager ?? resolved.receiptManager ?? new ReceiptManager(process.env.RECEIPT_SIGNING_SECRET);
  }
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

  const getOrigin = (req: Request) => `${req.protocol}://${req.get('host') || 'localhost'}`;

  const maybeAttachReceipt = (req: Request, res: Response, contract: unknown) => {
    if (req.query.receipt === 'true' && contract && typeof contract === 'object') {
      const receipt = receiptManager.issueReceipt(contract as Record<string, unknown>, getOrigin(req));
      res.setHeader('Receipt', receipt);
    }
  };

  app.get('/.well-known/talenttrust-receipts.json', wrap(() => receiptManager.getPublishedKeys()));

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
        'GET  /.well-known/talenttrust-receipts.json',
        'GET  /api/v1/chain',
        'GET  /api/v1/stats',
        'GET  /api/v1/contracts',
        'POST /api/v1/contracts',
        'GET  /api/v1/contracts/:id',
        'GET  /api/v1/contracts/:id/receipt',
        'POST /api/v1/contracts/:id/deposit',
        'POST /api/v1/contracts/:id/milestones/:index/release',
        'POST /api/v1/contracts/:id/dispute',
        'POST /api/v1/contracts/:id/resolve',
        'POST /api/v1/contracts/:id/cancel',
        'POST /api/v1/contracts/:id/reputation',
        'POST /api/v1/contracts/:id/link',
        'GET  /api/v1/contracts/:id/parity',
        'GET  /api/v1/reputation/:address',
        'POST /api/v1/receipts/verify',
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
      const created = store.create(req.body ?? {});
      maybeAttachReceipt(req, res, created);
      res.status(201).json(created);
    }),
  );
  v1.get('/contracts/:id', wrap((req) => store.get(id(req))));
  v1.get(
    '/contracts/:id/receipt',
    wrap((req) => {
      const contract = store.get(id(req));
      const receipt = receiptManager.issueReceipt(contract as unknown as Record<string, unknown>, getOrigin(req));
      return { receipt };
    }),
  );
  v1.post(
    '/contracts/:id/deposit',
    wrap((req, res) => {
      const updated = store.deposit(id(req), req.body?.amount);
      maybeAttachReceipt(req, res, updated);
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/milestones/:index/release',
    wrap((req, res) => {
      const updated = store.release(id(req), Number(req.params.index));
      maybeAttachReceipt(req, res, updated);
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/dispute',
    wrap((req, res) => {
      const updated = store.openDispute(id(req), req.body?.raisedBy, req.body?.reason);
      maybeAttachReceipt(req, res, updated);
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/resolve',
    wrap((req, res) => {
      const updated = store.resolveDispute(id(req), req.body?.freelancerBps);
      maybeAttachReceipt(req, res, updated);
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/cancel',
    wrap((req, res) => {
      const updated = store.cancel(id(req));
      maybeAttachReceipt(req, res, updated);
      return updated;
    }),
  );
  v1.post(
    '/contracts/:id/reputation',
    wrap((req, res) => {
      const updated = store.rate(id(req), req.body?.rating);
      maybeAttachReceipt(req, res, updated);
      return updated;
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

  v1.post(
    '/receipts/verify',
    wrap((req) => {
      const receipt = req.body?.receipt;
      if (!receipt || typeof receipt !== 'string') {
        throw new HttpError(400, 'invalid_receipt', 'receipt must be a non-empty JWS string');
      }

      const verified = verifyReceipt(receipt, receiptManager.publicKey);
      if (!verified.valid) {
        return {
          valid: false,
          kid: verified.kid ?? null,
          iat: verified.iat ?? null,
          contractId: verified.contractId ?? null,
          matchesCurrent: false,
        };
      }

      let matchesCurrent = false;
      if (verified.contractId) {
        try {
          const current = store.get(verified.contractId);
          matchesCurrent = hashContractState(current) === verified.contractHash;
        } catch {
          matchesCurrent = false;
        }
      }

      return {
        valid: true,
        kid: verified.kid,
        iat: verified.iat,
        contractId: verified.contractId,
        matchesCurrent,
      };
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
