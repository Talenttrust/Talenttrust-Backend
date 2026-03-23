import express, { NextFunction, Request, Response } from 'express';
import { AppError } from './errors/appError';
import { notFoundHandler, errorHandler } from './middleware/errorHandlers';
import { requestContext } from './middleware/requestContext';
import { AppConfig } from './config';
import { ContractsProvider, DefaultContractsProvider } from './dependencies/contractsProvider';

interface CreateAppOptions {
  config: AppConfig;
  contractsProvider?: ContractsProvider;
}

/**
 * Builds the application with centralized request context and error handling.
 */
export function createApp(options: CreateAppOptions): express.Express {
  const app = express();
  const contractsProvider = options.contractsProvider ?? new DefaultContractsProvider();

  app.use(requestContext);
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'talenttrust-backend' });
  });

  app.post('/api/v1/contracts/validate', (req: Request, res: Response, next: NextFunction) => {
    const id = req.body?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      next(new AppError(400, 'validation_error', 'Field "id" must be a non-empty string'));
      return;
    }

    res.status(201).json({ id });
  });

  app.get('/api/v1/contracts', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const contracts = await contractsProvider.listContracts();
      res.json({ contracts });
    } catch (error) {
      next(error);
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
