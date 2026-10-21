import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';

import helmet from 'helmet';
import { config, explorerUrl } from './config';
import { EscrowStore, HttpError } from './store';
import { openapi, docsHtml } from './openapi';
import { ProfileStore, profileSigningMessage } from './profiles';
import { createLogger, type Logger, randomUUID } from './logger';

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
  profileStore: ProfileStore = new ProfileStore(),
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
        'GET  /api/v1/profiles/:address',
        'PUT  /api/v1/profiles/:address',
        'GET  /api/v1/profiles',
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

  const expandParties = (req: Request) => req.query.expand === 'parties';
  const expandContract = (req: Request, contract: Record<string, unknown>) => {
    if (!expandParties(req)) return contract;
    const client = contract.client as string | undefined;
    const freelancer = contract.freelancer as string | undefined;
    return {
      ...contract,
      clientProfile: client ? profileStore.find(client) ?? null : null,
      freelancerProfile: freelancer ? profileStore.find(freelancer) ?? null : null,
    };
  };

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
      const data = store.list({
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        party: typeof req.query.party === 'string' ? req.query.party : undefined,
      });
      return { data: data.map((c) => expandContract(req, c as Record<string, unknown>)) };
    }),
  );
  v1.post(
    '/contracts',
    wrap((req, res) => {
      const created = store.create(req.body ?? {});
      res.status(201).json(expandContract(req, created as Record<string, unknown>));
    }),
  );
  v1.get('/contracts/:id', wrap((req) => expandContract(req, store.get(id(req)) as Record<string, unknown>)));
  v1.post('/contracts/:id/deposit', wrap((req) => expandContract(req, store.deposit(id(req), req.body?.amount) as Record<string, unknown>)));
  v1.post(
    '/contracts/:id/milestones/:index/release',
    wrap((req) => expandContract(req, store.release(id(req), Number(req.params.index)) as Record<string, unknown>)),
  );
  v1.post(
    '/contracts/:id/dispute',
    wrap((req) => expandContract(req, store.openDispute(id(req), req.body?.raisedBy, req.body?.reason) as Record<string, unknown>)),
  );
  v1.post('/contracts/:id/resolve', wrap((req) => expandContract(req, store.resolveDispute(id(req), req.body?.freelancerBps) as Record<string, unknown>)));
  v1.post('/contracts/:id/cancel', wrap((req) => expandContract(req, store.cancel(id(req)) as Record<string, unknown>)));
  v1.post('/contracts/:id/reputation', wrap((req) => expandContract(req, store.rate(id(req), req.body?.rating) as Record<string, unknown>)));
  v1.get('/reputation/:address', wrap((req) => store.getReputation(req.params.address)));

  v1.get('/profiles/:address', wrap((req) => {
    const address = profileStore.validateAddress(req.params.address);
    const profile = profileStore.find(address);
    if (!profile) throw new HttpError(404, 'profile_not_found', 'Profile not found');
    return { ...profile, reputation: store.getReputation(address) };
  }));
  v1.put('/profiles/:address', wrap((req) => {
    const address = profileStore.validateAddress(req.params.address);
    const body = req.body ?? {};
    const nonce = body.nonce;
    const signature = body.signature;
    if (typeof nonce !== 'number' || !Number.isInteger(nonce) || nonce < 1) {
      throw new HttpError(400, 'invalid_nonce', 'nonce must be a positive integer');
    }
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new HttpError(400, 'invalid_signature', 'signature is required');
    }
    const profileInput = profileStore.normalizeInput(body.profile);
    const message = profileSigningMessage(address, nonce, profileInput);
    profileStore.verifySignature(address, message, signature);
    const updated = profileStore.upsert(address, profileInput, nonce);
    return { ...updated, reputation: store.getReputation(address) };
  }));
  v1.get('/profiles', wrap((req) => {
    const skill = typeof req.query.skill === 'string' ? req.query.skill : undefined;
    const limitRaw = typeof req.query.limit === 'string' ? req.query.limit : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HttpError(400, 'invalid_limit', 'limit must be an integer between 1 and 100');
    }
    const result = profileStore.searchBySkill(skill, limit, cursor, (a) => store.getReputation(a));
    return {
      data: result.data.map((p) => ({ ...p, reputation: store.getReputation(p.address) })),
      nextCursor: result.nextCursor,
    };
  }));
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