import { readObservabilityConfig } from './observability-config';

describe('readObservabilityConfig', () => {
  it('uses secure and production-safe defaults', () => {
    const config = readObservabilityConfig({});

    expect(config.port).toBe(3001);
    expect(config.serviceName).toBe('talenttrust-backend');
    expect(config.metrics.enabled).toBe(true);
    expect(config.metrics.authToken).toBeUndefined();
  });

  it('parses booleans and numbers from env', () => {
    const config = readObservabilityConfig({
      PORT: '8080',
      SERVICE_NAME: 'backend-api',
      METRICS_ENABLED: 'false',
      METRICS_AUTH_TOKEN: 'abc123',
    });

    expect(config.port).toBe(8080);
    expect(config.serviceName).toBe('backend-api');
    expect(config.metrics.enabled).toBe(false);
    expect(config.metrics.authToken).toBe('abc123');
  });
});

