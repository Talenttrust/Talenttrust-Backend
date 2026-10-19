import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
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

const startedAt = Date.now();

type Handler = (req: Request, res: Response) => unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    next(err);
  }
};

export function createApp(store: EscrowStore = new EscrowStore().seed()) {
  const app = express();
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
  v1.get('/stats', wrap(() => store.stats()));
  v1.get(
    '/contracts',
    validate({ query: ListQuery }),
    wrap((req) => ({
      data: store.list({
        status: req.query.status as string | undefined,
        party: req.query.party as string | undefined,
      }),
    })),
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
    wrap((req) => store.get(Number(req.params.id))),
  );
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
    wrap((req) => store.getReputation(req.params.address)),
  );
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