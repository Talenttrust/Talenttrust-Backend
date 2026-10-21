import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, explorerUrl } from './config';
import { EscrowStore, HttpError } from './store';
import { openapi, docsHtml } from './openapi';
import { createLogger, type Logger, randomUUID } from './logger';
import { CSV_HEADERS, csvRow } from './csv';

declare global {
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

const startedAt = Date.now();

type LoggerLevel = 'debug' | 'info' | 'warn' | 'error';

type Handler = (req: Request, res: Response) => unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = fn(req, res);
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
  storeOrOpts: EscrowStore | { logger?: Logger; store?: EscrowStore } = new EscrowStore().seed(),
): { store: EscrowStore; logger: Logger } {
  if (
    storeOrOpts &&
    typeof storeOrOpts === 'object' &&
    'list' in storeOrOpts &&
    typeof (storeOrOpts as EscrowStore).list === 'function'
  ) {
    return { store: storeOrOpts as EscrowStore, logger: createLogger() };
  }
  const opts = (storeOrOpts as { logger?: Logger; store?: EscrowStore } | undefined) ?? {};
  return { store: opts.store ?? new EscrowStore().seed(), logger: opts.logger ?? createLogger() };
}

export function createApp(
  storeOrOpts: EscrowStore | { logger?: Logger; store?: EscrowStore } = new EscrowStore().seed(),
) {
  const { store, logger } = resolveStoreAndLogger(storeOrOpts);
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
        'GET  /api/v1/reputation/:address',
        'GET  /api/v1/parties/:address/statement.csv',
        'GET  /api/v1/parties/:address/statement.json',
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
    wrap((req) => ({
      data: store.list({
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        party: typeof req.query.party === 'string' ? req.query.party : undefined,
      }),
    })),
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
  v1.get('/reputation/:address', wrap((req) => store.getReputation(req.params.address)));

  // ── Statement endpoints ────────────────────────────────────────────────────
  // Shared date-range parser used by both .csv and .json variants.
  function parseStatementParams(req: Request): {
    address: string;
    from: Date;
    to: Date;
    role: 'client' | 'freelancer' | 'all';
    bom: boolean;
  } {
    const address = req.params.address;
    const MAX_RANGE_MS = 3 * 365.25 * 24 * 60 * 60 * 1000; // ~3 years
    const DEFAULT_RANGE_MS = 365 * 24 * 60 * 60 * 1000;    // 365 days

    const toDate = req.query.to
      ? new Date(String(req.query.to))
      : new Date(Date.now());
    const fromDate = req.query.from
      ? new Date(String(req.query.from))
      : new Date(toDate.getTime() - DEFAULT_RANGE_MS);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new HttpError(400, 'invalid_range', 'from and to must be valid ISO dates');
    }
    if (fromDate >= toDate) {
      throw new HttpError(400, 'invalid_range', 'from must be before to');
    }
    if (toDate.getTime() - fromDate.getTime() > MAX_RANGE_MS) {
      throw new HttpError(400, 'invalid_range', 'date range must not exceed 3 years');
    }

    const roleRaw = typeof req.query.role === 'string' ? req.query.role : 'all';
    if (roleRaw !== 'client' && roleRaw !== 'freelancer' && roleRaw !== 'all') {
      throw new HttpError(400, 'invalid_role', 'role must be client, freelancer, or all');
    }

    const bom = req.query.bom === 'true';
    return { address, from: fromDate, to: toDate, role: roleRaw, bom };
  }

  v1.get('/parties/:address/statement.csv', (req, res, next) => {
    try {
      const { address, from, to, role, bom } = parseStatementParams(req);
      const rows = store.getStatement(address, from, to, role);
      const safeAddress = address.replace(/[^A-Za-z0-9_-]/g, '_');
      const fromStr = from.toISOString().slice(0, 10);
      const toStr = to.toISOString().slice(0, 10);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="talenttrust-${safeAddress}-${fromStr}-${toStr}.csv"`,
      );

      // UTF-8 BOM for Excel compatibility when ?bom=true
      if (bom) res.write('\uFEFF');

      // Stream: header row then one data row per contract
      res.write(csvRow(CSV_HEADERS));
      for (const row of rows) {
        res.write(
          csvRow([
            row.contract_id,
            row.title,
            row.role,
            row.counterparty,
            row.token,
            row.status,
            row.total_amount,
            row.funded_amount,
            row.released_amount,
            row.outstanding_amount,
            row.dispute_freelancer_bps,
            row.created_at,
            row.updated_at,
          ]),
        );
      }
      res.end();
    } catch (err) {
      next(err);
    }
  });

  v1.get('/parties/:address/statement.json', (req, res, next) => {
    try {
      const { address, from, to, role } = parseStatementParams(req);
      const rows = store.getStatement(address, from, to, role);
      res.json({ address, from: from.toISOString(), to: to.toISOString(), role, data: rows });
    } catch (err) {
      next(err);
    }
  });

  app.use('/api/v1', v1);

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}`, requestId: req.id, docs: '/docs' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = req.id;
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, requestId });
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
