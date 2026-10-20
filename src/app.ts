import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { EscrowStore, HttpError } from './store';
import {
  API_PREFIX,
  allowedMethods,
  apiRoutes,
  buildRoutes,
  registerRoute,
  topLevelRoutes,
} from './routes';

const startedAt = Date.now();

export function createApp(store: EscrowStore = new EscrowStore().seed()) {
  const app = express();
  app.disable('x-powered-by');
  // CSP disabled so the /docs page can load Swagger UI from a CDN.
  app.use(helmet({ contentSecurityPolicy: false }));
  // Let our own OPTIONS handler answer with an `Allow` header; cors() still
  // adds the CORS response headers for preflight requests.
  app.use(cors({ preflightContinue: true }));
  app.use(express.json({ limit: '100kb' }));

  const routes = buildRoutes(store, startedAt);

  // Express answers OPTIONS automatically inside routers (200, no body) before
  // middleware mounted after the router runs. Handle OPTIONS up front so a
  // known path always returns 204 with an `Allow` header.
  app.use((req, res, next) => {
    if (req.method !== 'OPTIONS') {
      next();
      return;
    }
    const allowed = allowedMethods(routes, req.path);
    if (allowed.length === 0) {
      next();
      return;
    }
    res.set('Allow', allowed.join(', '));
    res.status(204).end();
  });

  for (const route of topLevelRoutes(routes)) registerRoute(app, route);

  const v1 = express.Router();
  for (const route of apiRoutes(routes)) registerRoute(v1, route, API_PREFIX);
  app.use(API_PREFIX, v1);

  // Known path, unsupported method: 405 with the methods that are supported.
  app.use((req, res, next) => {
    const allowed = allowedMethods(routes, req.path);
    if (allowed.length === 0) {
      next();
      return;
    }
    res.set('Allow', allowed.join(', '));
    res.status(405).json({
      error: 'method_not_allowed',
      message: `Method ${req.method} is not allowed for ${req.path}`,
      allowed,
    });
  });

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
