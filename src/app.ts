import express, { NextFunction, Request, Response } from 'express';

import { getPublicRuntimeConfig, RuntimeConfig, SERVICE_NAME } from './config/runtime-config';

interface FeatureDisabledResponse {
  error: 'feature_disabled';
  feature: string;
  message: string;
}

function buildFeatureDisabledResponse(feature: string): FeatureDisabledResponse {
  return {
    error: 'feature_disabled',
    feature,
    message: `The ${feature} feature is disabled by runtime configuration.`,
  };
}

function requireFeature(enabled: boolean, feature: string) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (!enabled) {
      res.status(404).json(buildFeatureDisabledResponse(feature));
      return;
    }

    next();
  };
}

/**
 * @notice Create the Express app with runtime configuration injected for safe testing.
 * @param config Validated runtime configuration.
 * @returns Configured Express application.
 */
export function createApp(config: RuntimeConfig) {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: SERVICE_NAME });
  });

  app.get(
    '/api/v1/contracts',
    requireFeature(config.features.contractsApiEnabled, 'contracts_api'),
    (_req: Request, res: Response) => {
      res.json({ contracts: [] });
    },
  );

  app.get(
    '/api/v1/runtime-config',
    requireFeature(
      config.features.runtimeConfigEndpointEnabled,
      'runtime_config_endpoint',
    ),
    (_req: Request, res: Response) => {
      res.json({
        service: SERVICE_NAME,
        ...getPublicRuntimeConfig(config),
      });
    },
  );

  return app;
}
