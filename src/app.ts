import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, explorerUrl } from './config';
import { EscrowStore, HttpError } from './store';
import { openapi, docsHtml } from './openapi';
import { ChainReadClient, ChainReadError, SorobanChainReadClient } from './stellar/client';
import { StrKey } from '@stellar/stellar-sdk';

const startedAt = Date.now();

type Handler = (req: Request, res: Response) => unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = fn(req, res);
    Promise.resolve(out).then((value) => {
      if (value !== undefined && !res.headersSent) res.json(value);
    }, next);
  } catch (err) {
    next(err);
  }
};

class ChainReadCache {
  private readonly values = new Map<string, { expiresAt: number; promise: Promise<unknown> }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 256) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > now) return cached.promise as Promise<T>;
    if (cached) this.values.delete(key);
    while (this.values.size >= this.maxEntries) this.values.delete(this.values.keys().next().value as string);
    const promise = load();
    this.values.set(key, { expiresAt: now + this.ttlMs, promise });
    promise.catch(() => {
      if (this.values.get(key)?.promise === promise) this.values.delete(key);
    });
    return promise;
  }
}

class ChainRateLimiter {
  private readonly clients = new Map<string, { windowStarted: number; count: number }>();

  constructor(private readonly maxRequests = 60, private readonly windowMs = 60_000, private readonly maxClients = 1024) {}

  allow(key: string): boolean {
    const now = Date.now();
    const current = this.clients.get(key);
    if (!current || now - current.windowStarted >= this.windowMs) {
      while (this.clients.size >= this.maxClients) this.clients.delete(this.clients.keys().next().value as string);
      this.clients.set(key, { windowStarted: now, count: 1 });
      return true;
    }
    if (current.count >= this.maxRequests) return false;
    current.count += 1;
    return true;
  }
}

const chainId = (raw: string): bigint => {
  if (!/^[1-9]\d*$/.test(raw)) throw new HttpError(400, 'invalid_chain_id', 'chainId must be a positive u64');
  const value = BigInt(raw);
  if (value > 18_446_744_073_709_551_615n) {
    throw new HttpError(400, 'invalid_chain_id', 'chainId must be a positive u64');
  }
  return value;
};

const stellarAddress = (raw: string): string => {
  if (!StrKey.isValidEd25519PublicKey(raw)) throw new HttpError(400, 'invalid_address', 'address must be a valid Stellar account');
  return raw;
};

const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid_id', 'id must be a positive integer');
  return n;
};

export function createApp(store: EscrowStore = new EscrowStore().seed(), chainClient: ChainReadClient = new SorobanChainReadClient()) {
  const app = express();
  const ttl = Number(process.env.CHAIN_READ_TTL_MS ?? 5000);
  const chainCache = new ChainReadCache(Number.isFinite(ttl) && ttl >= 0 ? ttl : 5000);
  const chainRateLimiter = new ChainRateLimiter();
  const allowChainRead = (req: Request, res: Response) => {
    if (!chainRateLimiter.allow(req.ip || 'unknown')) {
      res.setHeader('Retry-After', '60');
      throw new HttpError(429, 'chain_rate_limited', 'Too many chain read requests');
    }
  };
  app.disable('x-powered-by');
  // CSP disabled so the /docs page can load Swagger UI from a CDN.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

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
        'GET  /api/v1/chain/contracts/:chainId',
        'GET  /api/v1/chain/reputation/:address',
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
      ],
    })),
  );

  app.get(
    '/health',
    wrap(() => ({
      status: 'ok',
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      storage: 'in-memory',
      timestamp: new Date().toISOString(),
    })),
  );

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
  v1.get('/chain/contracts/:chainId', wrap(async (req, res) => {
    allowChainRead(req, res);
    const id = chainId(req.params.chainId);
    const result = await chainCache.get(`contract:${id}`, () => chainClient.getContract(id));
    return { ...result.value, source: 'chain', latestLedger: result.latestLedger };
  }));
  v1.get('/chain/reputation/:address', wrap(async (req, res) => {
    allowChainRead(req, res);
    const address = stellarAddress(req.params.address);
    const result = await chainCache.get(`reputation:${address}`, () => chainClient.getReputation(address));
    const averageRating = result.value.completedContracts
      ? Math.round((result.value.totalRating / result.value.completedContracts) * 100) / 100
      : 0;
    return {
      address,
      completedContracts: result.value.completedContracts,
      totalRating: result.value.totalRating,
      averageRating,
      source: 'chain',
    };
  }));
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
  app.use('/api/v1', v1);

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}`, docs: '/docs' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof ChainReadError) {
      if (err.failure === 'not_found') {
        res.status(404).json({ error: 'contract_not_found', message: 'On-chain contract not found' });
      } else if (err.failure === 'contract') {
        res.status(502).json({ error: 'chain_error', message: 'On-chain read failed', contractError: err.contractError });
      } else {
        res.setHeader('Retry-After', '1');
        res.status(503).json({ error: 'chain_unavailable', message: 'On-chain service temporarily unavailable' });
      }
      return;
    }
    if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'Malformed JSON body' });
      return;
    }
    res.status(500).json({ error: 'internal_error', message: 'Unexpected error' });
  });

  return app;
}

export default createApp;
