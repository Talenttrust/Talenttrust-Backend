import express from 'express';
import request from 'supertest';
import { Logger } from '../logger';
import {
  classifyReputationResponse,
  createReputationObservabilityMiddleware,
} from './reputation-observability';
import { ReputationRequestMetric } from './metrics-service';

type LogRecord = {
  message: string;
  fields: Record<string, unknown>;
};

function createLoggerSpy(): {
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  records: LogRecord[];
} {
  const records: LogRecord[] = [];
  const record = (message: string, fields: Record<string, unknown> = {}): void => {
    records.push({ message, fields });
  };

  return {
    logger: {
      info: jest.fn(record),
      warn: jest.fn(record),
      error: jest.fn(record),
    },
    records,
  };
}

function createMetricsSpy(
  implementation?: (metric: ReputationRequestMetric) => void,
): { recordReputationRequest: jest.Mock<void, [ReputationRequestMetric]> } {
  return {
    recordReputationRequest: jest.fn(implementation),
  };
}

function buildApp(
  metrics: { recordReputationRequest: jest.Mock<void, [ReputationRequestMetric]> },
  logger: Pick<Logger, 'info' | 'warn' | 'error'>,
): express.Application {
  const app = express();
  app.use(express.json());
  app.use(createReputationObservabilityMiddleware({ metricsService: metrics, log: logger }));
  app.get('/:id', (req, res) => {
    if (req.query['failure'] === 'server') {
      throw new Error('database details must not be logged');
    }
    res.status(200).json({ ok: true });
  });
  app.put('/:id', (_req, res) => {
    res.status(400).json({ error: 'invalid rating' });
  });
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}

describe('classifyReputationResponse', () => {
  it.each([
    [200, { status: 'success', errorCause: 'none' }],
    [302, { status: 'success', errorCause: 'none' }],
    [400, { status: 'client_error', errorCause: 'bad_request' }],
    [401, { status: 'client_error', errorCause: 'authentication' }],
    [403, { status: 'client_error', errorCause: 'authorization' }],
    [404, { status: 'client_error', errorCause: 'not_found' }],
    [409, { status: 'client_error', errorCause: 'conflict' }],
    [422, { status: 'client_error', errorCause: 'validation' }],
    [429, { status: 'client_error', errorCause: 'rate_limit' }],
    [418, { status: 'client_error', errorCause: 'client_error' }],
    [500, { status: 'server_error', errorCause: 'internal_error' }],
  ])('maps status %i to bounded observability labels', (statusCode, expected) => {
    expect(classifyReputationResponse(statusCode)).toEqual(expected);
  });
});

describe('createReputationObservabilityMiddleware', () => {
  it('records and logs a successful GET without PII', async () => {
    const metrics = createMetricsSpy();
    const { logger, records } = createLoggerSpy();
    const app = buildApp(metrics, logger);
    const privateId = 'freelancer-private-123';

    const response = await request(app)
      .get(`/${privateId}`)
      .query({ note: 'private@example.com' });

    expect(response.status).toBe(200);
    expect(metrics.recordReputationRequest).toHaveBeenCalledTimes(1);
    expect(metrics.recordReputationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'get_profile',
        status: 'success',
        statusCode: 200,
        errorCause: 'none',
        durationSeconds: expect.any(Number),
      }),
    );
    expect(records).toContainEqual({
      message: 'reputation_request',
      fields: expect.objectContaining({
        method: 'GET',
        operation: 'get_profile',
        status: 'success',
        statusCode: 200,
        errorCause: 'none',
        durationMs: expect.any(Number),
      }),
    });
    expect(JSON.stringify(records)).not.toContain(privateId);
    expect(JSON.stringify(records)).not.toContain('private@example.com');
  });

  it('records a client error with a validation cause and warns', async () => {
    const metrics = createMetricsSpy();
    const { logger, records } = createLoggerSpy();
    const response = await request(buildApp(metrics, logger))
      .put('/freelancer-private-456')
      .send({ reviewerId: 'client-private-789', comment: 'private@example.com' });

    expect(response.status).toBe(400);
    expect(metrics.recordReputationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'create_rating',
        status: 'client_error',
        statusCode: 400,
        errorCause: 'bad_request',
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'reputation_request',
      expect.objectContaining({
        status: 'client_error',
        errorCause: 'bad_request',
      }),
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(JSON.stringify(records)).not.toContain('freelancer-private-456');
    expect(JSON.stringify(records)).not.toContain('client-private-789');
    expect(JSON.stringify(records)).not.toContain('private@example.com');
  });

  it('records a server error and emits an error-level log', async () => {
    const metrics = createMetricsSpy();
    const { logger } = createLoggerSpy();
    const response = await request(buildApp(metrics, logger))
      .get('/freelancer-private-999')
      .query({ failure: 'server' });

    expect(response.status).toBe(500);
    expect(metrics.recordReputationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'get_profile',
        status: 'server_error',
        statusCode: 500,
        errorCause: 'internal_error',
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'reputation_request',
      expect.objectContaining({
        status: 'server_error',
        errorCause: 'internal_error',
      }),
    );
  });

  it('does not instrument unsupported HTTP methods', async () => {
    const metrics = createMetricsSpy();
    const { logger } = createLoggerSpy();
    const app = buildApp(metrics, logger);
    app.patch('/:id', (_req, res) => res.status(204).send());

    const response = await request(app).patch('/private-id');

    expect(response.status).toBe(204);
    expect(metrics.recordReputationRequest).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not let a metrics failure alter the completed response', async () => {
    const metrics = createMetricsSpy(() => {
      throw new Error('registry unavailable');
    });
    const { logger } = createLoggerSpy();

    const response = await request(buildApp(metrics, logger)).get('/private-id');

    expect(response.status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(
      'reputation_metrics_recording_failed',
      expect.objectContaining({
        operation: 'get_profile',
        status: 'success',
        statusCode: 200,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'reputation_request',
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('uses the request-scoped logger when one is available', async () => {
    const metrics = createMetricsSpy();
    const fallback = createLoggerSpy();
    const requestScoped = createLoggerSpy();
    const app = express();
    app.use((_req, res, next) => {
      res.locals['log'] = requestScoped.logger;
      next();
    });
    app.use(createReputationObservabilityMiddleware({
      metricsService: metrics,
      log: fallback.logger,
    }));
    app.get('/:id', (_req, res) => res.status(200).send());

    const response = await request(app).get('/private-id');

    expect(response.status).toBe(200);
    expect(requestScoped.logger.info).toHaveBeenCalledWith(
      'reputation_request',
      expect.objectContaining({ operation: 'get_profile' }),
    );
    expect(fallback.logger.info).not.toHaveBeenCalled();
  });

  it('supports logging without a metrics recorder', async () => {
    const infoSpy = jest.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
    const app = express();
    app.use(createReputationObservabilityMiddleware());
    app.get('/:id', (_req, res) => res.status(200).send());

    try {
      const response = await request(app).get('/private-id');

      expect(response.status).toBe(200);
      expect(infoSpy).toHaveBeenCalledWith(
        'reputation_request',
        expect.objectContaining({ status: 'success' }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });
});
