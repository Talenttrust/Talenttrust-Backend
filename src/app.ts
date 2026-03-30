import express, { Request, Response } from 'express';
import {
  ContractsService,
} from './contracts/contracts.service';
import { InMemoryContractRepository } from './contracts/contracts.repository';
import { StellarRpcClient } from './contracts/contracts.rpc';
import { createRequestTracingMiddleware } from './tracing/request-tracing';
import { Tracer } from './tracing/tracer';

export interface AppDependencies {
  tracer?: Tracer;
  contractsService?: ContractsService;
}

export const createApp = (dependencies: AppDependencies = {}) => {
  const tracer = dependencies.tracer ?? new Tracer();
  const contractsService =
    dependencies.contractsService ??
    new ContractsService(
      new InMemoryContractRepository(tracer),
      new StellarRpcClient(tracer),
    );

  const app = express();
  app.use(express.json());
  app.use(createRequestTracingMiddleware(tracer));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'talenttrust-backend' });
  });

  app.get('/api/v1/contracts', async (_req: Request, res: Response) => {
    const payload = await contractsService.listContracts(res);
    res.json(payload);
  });

  return { app, tracer, contractsService };
};
