import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, explorerUrl } from './config';
import { EscrowStore, HttpError } from './store';
import { openapi, docsHtml } from './openapi';
import { isWebhookAdminTokenValid, WebhookManager } from './webhooks';

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

const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid_id', 'id must be a positive integer');
  return n;
};

export function createApp(store: EscrowStore = new EscrowStore().seed()) {
  const app = express();
  const webhooks = new WebhookManager(store.events);
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

  const webhookAuth = (req: Request) => {
    const configured = process.env.WEBHOOK_ADMIN_TOKEN;
    if (!configured) throw new HttpError(404, 'not_found', 'Not found');
    if (!isWebhookAdminTokenValid(configured, req.header('authorization'))) {
      throw new HttpError(401, 'unauthorized', 'Webhook administration authentication is required');
    }
  };
  const webhookRouter = express.Router();
  webhookRouter.post('/', wrap(async (req, res) => {
    webhookAuth(req);
    const created = await webhooks.create(req.body ?? {});
    res.status(201).json({ ...created.subscription, secret: created.secret });
  }));
  webhookRouter.get('/', wrap((req) => {
    webhookAuth(req);
    return { data: webhooks.list() };
  }));
  webhookRouter.get('/:id', wrap((req) => {
    webhookAuth(req);
    return webhooks.get(req.params.id);
  }));
  webhookRouter.patch('/:id', wrap(async (req) => {
    webhookAuth(req);
    return webhooks.update(req.params.id, req.body ?? {});
  }));
  webhookRouter.delete('/:id', wrap((req) => {
    webhookAuth(req);
    return webhooks.remove(req.params.id);
  }));
  webhookRouter.post('/:id/rotate-secret', wrap((req) => {
    webhookAuth(req);
    const rotated = webhooks.rotateSecret(req.params.id);
    return { ...rotated.subscription, secret: rotated.secret };
  }));
  webhookRouter.get('/:id/deliveries', wrap((req) => {
    webhookAuth(req);
    return { data: webhooks.history(req.params.id) };
  }));
  v1.use('/webhook-subscriptions', webhookRouter);
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
