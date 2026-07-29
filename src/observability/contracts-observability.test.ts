import express from 'express';
import request from 'supertest';
import { Logger } from '../logger';
import {
  classifyContractsResponse,
  createContractsObservabilityMiddleware,
} from './contracts-observability';
import { ContractsRequestMetric } from './metrics-service';

type LogRecord = {
  level: 'info' | 'warn' | 'error';
  message: string;
  fields: Record<string, unknown>;
};

function createLoggerSpy(): {
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  records: LogRecord[];
} {
  const records: LogRecord[] = [];
  const record = (level: 'info' | 'warn' | 'error') => (
    message: string,
    fields: Record<string, unknown> = {},
  ): void => {
    records.push({ level, message, fields });
  };

  return {
    logger: {
      info: jest.fn(record('info')),
      warn: jest.fn(record('warn')),
      error: jest.fn(record('error')),
    },
    records,
  };
}

function createMetricsSpy(
  implementation?: (metric: ContractsRequestMetric) => void,
): { recordContractsRequest: jest.Mock<void, [ContractsRequestMetric]> } {
  return {
    recordContractsRequest: jest.fn(implementation),
  };
}

function buildApp(
  metrics?: { recordContractsRequest: jest.Mock<void, [ContractsRequestMetric]> },
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>,
): express.Application {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    if (req.headers['x-request-id']) {
      res.locals.requestId = req.headers['x-request-id'] as string;
    }
    if (req.headers['x-correlation-id']) {
      res.locals.correlationId = req.headers['x-correlation-id'] as string;
    }
    next();
  });

  app.use(
    createContractsObservabilityMiddleware({
      metricsService: metrics,
      log: logger,
    }),
  );

  app.get('/api/v1/contracts', (req, res) => {
    if (req.query['failure'] === 'server') {
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    res.status(200).json({ status: 'success', data: [] });
  });

  app.post('/api/v1/contracts', (req, res) => {
    if (req.body?.fail === 'bounds') {
      res.status(422).json({ error: 'contract_bounds_error' });
      return;
    }
    res.status(201).json({ status: 'success', data: { id: 'contract-1' } });
  });

  app.get('/api/v1/contracts/:id', (req, res) => {
    if (req.params.id === 'missing') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(200).json({ status: 'success', data: { id: req.params.id } });
  });

  return app;
}

describe('classifyContractsResponse', () => {
  it.each([
    [200, { status: 'success', errorCause: 'none' }],
    [201, { status: 'success', errorCause: 'none' }],
    [302, { status: 'success', errorCause: 'none' }],
    [400, { status: 'client_error', errorCause: 'bad_request' }],
    [401, { status: 'client_error', errorCause: 'authentication' }],
    [403, { status: 'client_error', errorCause: 'authorization' }],
    [404, { status: 'client_error', errorCause: 'not_found' }],
    [409, { status: 'client_error', errorCause: 'conflict' }],
    [422, { status: 'client_error', errorCause: 'contract_bounds_error' }],
    [429, { status: 'client_error', errorCause: 'rate_limit' }],
    [418, { status: 'client_error', errorCause: 'client_error' }],
    [500, { status: 'server_error', errorCause: 'internal_error' }],
    [503, { status: 'server_error', errorCause: 'internal_error' }],
  ])('maps status %i to bounded status and errorCause labels', (statusCode, expected) => {
    expect(classifyContractsResponse(statusCode)).toEqual(expected);
  });
});

describe('createContractsObservabilityMiddleware', () => {
  it('records metrics and logs a successful GET request without PII', async () => {
    const metrics = createMetricsSpy();
    const { logger, records } = createLoggerSpy();
    const app = buildApp(metrics, logger);

    const response = await request(app)
      .get('/api/v1/contracts')
      .query({ secret: 'user@example.com', creditCard: '411111111111' })
      .set('x-request-id', 'req-123')
      .set('x-correlation-id', 'corr-456');

    expect(response.status).toBe(200);
    expect(metrics.recordContractsRequest).toHaveBeenCalledTimes(1);
    expect(metrics.recordContractsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        route: '/api/v1/contracts',
        status: 'success',
        statusCode: 200,
        errorCause: 'none',
      }),
    );
    expect(metrics.recordContractsRequest.mock.calls[0][0].durationSeconds).toBeGreaterThanOrEqual(0);

    expect(records).toHaveLength(1);
    expect(records[0].level).toBe('info');
    expect(records[0].message).toBe('contracts_request');
    expect(records[0].fields).toEqual(
      expect.objectContaining({
        method: 'GET',
        route: '/api/v1/contracts',
        status: 'success',
        statusCode: 200,
        errorCause: 'none',
        requestId: 'req-123',
        correlationId: 'corr-456',
      }),
    );

    const loggedJson = JSON.stringify(records[0].fields);
    expect(loggedJson).not.toContain('user@example.com');
    expect(loggedJson).not.toContain('411111111111');
  });

  it('records metrics and logs a warn level log for client_error (422 contract_bounds_error)', async () => {
    const metrics = createMetricsSpy();
    const { logger, records } = createLoggerSpy();
    const app = buildApp(metrics, logger);

    const response = await request(app)
      .post('/api/v1/contracts')
      .send({ fail: 'bounds', budget: 999999999 });

    expect(response.status).toBe(422);
    expect(metrics.recordContractsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        route: '/api/v1/contracts',
        status: 'client_error',
        statusCode: 422,
        errorCause: 'contract_bounds_error',
      }),
    );

    expect(records).toHaveLength(1);
    expect(records[0].level).toBe('warn');
    expect(records[0].message).toBe('contracts_request');
    expect(records[0].fields.errorCause).toBe('contract_bounds_error');
  });

  it('records metrics and logs an error level log for server_error (500 internal_error)', async () => {
    const metrics = createMetricsSpy();
    const { logger, records } = createLoggerSpy();
    const app = buildApp(metrics, logger);

    const response = await request(app)
      .get('/api/v1/contracts')
      .query({ failure: 'server' });

    expect(response.status).toBe(500);
    expect(metrics.recordContractsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        route: '/api/v1/contracts',
        status: 'server_error',
        statusCode: 500,
        errorCause: 'internal_error',
      }),
    );

    expect(records).toHaveLength(1);
    expect(records[0].level).toBe('error');
    expect(records[0].message).toBe('contracts_request');
  });

  it('handles metric recording failure gracefully without breaking response', async () => {
    const metrics = createMetricsSpy(() => {
      throw new Error('Prometheus registry error');
    });
    const { logger, records } = createLoggerSpy();
    const app = buildApp(metrics, logger);

    const response = await request(app).get('/api/v1/contracts');

    expect(response.status).toBe(200);
    const failureLog = records.find((r) => r.message === 'contracts_metrics_recording_failed');
    expect(failureLog).toBeDefined();
    expect(failureLog?.level).toBe('error');
  });

  it('operates safely when metricsService and log options are omitted', async () => {
    const app = buildApp();
    const response = await request(app).get('/api/v1/contracts');
    expect(response.status).toBe(200);
  });

  it('extracts custom subpath route correctly when req.baseUrl is default', async () => {
    const metrics = createMetricsSpy();
    const app = express();
    app.use(createContractsObservabilityMiddleware({ metricsService: metrics }));
    app.get('/custom-subpath', (req, res) => res.status(200).json({ ok: true }));

    const response = await request(app).get('/custom-subpath');
    expect(response.status).toBe(200);
    expect(metrics.recordContractsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        route: '/api/v1/contracts/custom-subpath',
      }),
    );
  });
});
