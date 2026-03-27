import autocannon from 'autocannon';
import app from '../../index';
import { Server } from 'http';

/**
 * Load test for GET /health
 * Baseline: 10 concurrent connections for 10 seconds
 * Expects: zero errors, <100ms average latency
 */
describe('Load Test - GET /health', () => {
  let server: Server;

  beforeAll((done) => {
    // Start a local server for testing
     server = app.listen(3099, done);

  });

  afterAll((done) => {
    server.close(done);
  });

  it('should handle baseline load with no errors', async () => {
    const result = await autocannon({
      url: 'http://localhost:3099/health',
      connections: 10,   // 10 concurrent users
      duration: 10,      // for 10 seconds
      method: 'GET',
    });

    console.log(`RPS: ${result.requests.average}`);
    console.log(`Avg Latency: ${result.latency.average}ms`);
    console.log(`Errors: ${result.errors}`);

    expect(result.errors).toBe(0);
    expect(result.latency.average).toBeLessThan(100); // under 100ms
    expect(result.requests.average).toBeGreaterThan(50); // at least 50 RPS
  }, 30000); // 30s timeout for Jest
});
