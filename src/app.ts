import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, explorerUrl, storageConfig } from './config';
import { HttpError } from './domain';
import { EscrowService } from './service';
import { createRepository } from './repo';
import { openapi, docsHtml } from './openapi';

const startedAt = Date.now();

type Handler = (req: Request, res: Response) => unknown;
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

export function createApp(service?: EscrowService) {
  const options = service ? undefined : storageConfig();
  const store = service ?? new EscrowService(createRepository(options!));
  const ready = options?.seedDemoData ? store.seed() : Promise.resolve();
  // Mark initialization rejection as handled even before the first request arrives.
  void ready.catch(() => undefined);
  const app = express();
  app.locals.ready = ready;
  app.locals.close = async () => { await ready.catch(() => undefined); await store.repository.close(); };
  app.disable('x-powered-by');
  // CSP disabled so the /docs page can load Swagger UI from a CDN.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  app.use((_req, _res, next) => { void ready.then(() => next(), next); });

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
      ],
    })),
  );

  app.get(
    '/health',
    wrap(() => ({
      status: 'ok',
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      storage: store.repository.driver,
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
  v1.get('/stats', wrap(() => store.stats()));
  v1.get(
    '/contracts',
    wrap(async (req) => ({
      data: await store.list({
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        party: typeof req.query.party === 'string' ? req.query.party : undefined,
      }),
    })),
  );
  v1.post(
    '/contracts',
    wrap(async (req, res) => {
      res.status(201).json(await store.create(req.body ?? {}));
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
    if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'Malformed JSON body' });
      return;
    }
    res.status(500).json({ error: 'internal_error', message: 'Unexpected error' });
  });

  return app;
}

export default createApp;
