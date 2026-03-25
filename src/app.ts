import express, { Request, Response } from 'express';

import { incidentResponseRouter } from './incidentResponse.routes';

/**
 * Creates the Express application with repository-scoped routes.
 */
export function createApp() {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'talenttrust-backend' });
  });

  app.get('/api/v1/contracts', (_req: Request, res: Response) => {
    res.json({ contracts: [] });
  });

  app.use('/api/v1/incident-response', incidentResponseRouter);

  return app;
}
