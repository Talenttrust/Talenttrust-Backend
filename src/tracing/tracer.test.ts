import { InMemorySpanLogger, Tracer } from './tracer';

describe('Tracer', () => {
  it('preserves trace and parent relationships for nested spans', () => {
    const logger = new InMemorySpanLogger();
    const tracer = new Tracer(logger);

    tracer.withContext('trace-1', 'request-1', () => {
      const parentSpan = tracer.startSpan('GET /health', 'api');
      parentSpan.run(() => {
        const childSpan = tracer.startSpan('contracts.repository.list', 'db');
        childSpan.end();
      });
      parentSpan.end();
    });

    expect(logger.spans).toHaveLength(2);
    const parent = logger.spans.find((span) => span.name === 'GET /health');
    const child = logger.spans.find(
      (span) => span.name === 'contracts.repository.list',
    );

    expect(parent?.traceId).toBe('trace-1');
    expect(child?.parentSpanId).toBe(parent?.spanId);
  });

  it('records span errors', () => {
    const logger = new InMemorySpanLogger();
    const tracer = new Tracer(logger);
    const span = tracer.startSpan('contracts.rpc.fetch_registry_health', 'rpc');

    span.recordError(new Error('rpc unavailable'));
    span.end();

    expect(logger.spans[0].status).toBe('error');
    expect(logger.spans[0].error).toContain('rpc unavailable');
  });
});
