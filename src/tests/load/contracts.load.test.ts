import autocannon from "autocannon";
import app from "../../index";
import { Server } from "http";
import { DefaultServiceObjectives } from "../../operations/service-objectives";

/**
 * Load test for GET /api/v1/contracts
 * Validates against defined SLOs in src/operations/service-objectives.ts
 * Baseline: 20 concurrent connections for 10 seconds (CI-safe duration)
 */
describe("Load Test - GET /api/v1/contracts", () => {
  let server: Server;
  const TEST_PORT = 3098;
  const TEST_DURATION = 10; // CI-safe duration
  const CONCURRENT_CONNECTIONS = 20;
  
  // SLO Definitions from canonical source
  const contractsSLO = DefaultServiceObjectives.contractsApi;

  beforeAll((done) => {
    // Start a local server for testing
    server = app.listen(TEST_PORT, done);
  });

  afterAll((done) => {
    server.close(done);
  });

  it("should meet all SLO requirements under load", async () => {
    const result = (await autocannon({
      url: `http://localhost:${TEST_PORT}/api/v1/contracts`,
      connections: CONCURRENT_CONNECTIONS,
      duration: TEST_DURATION,
      method: "GET",
      timeout: 1000,
    })) as {
      requests: { average: number; total: number };
      latency: { average: number; p97_5?: number; p99?: number };
      errors: number;
      non2xx: number;
    };

    // Handle autocannon's property naming (uses underscores for decimals)
    const p95 = result.latency.p97_5 ?? 0; // Autocannon uses p97_5 for ~95th percentile equivalent
    const p99 = result.latency.p99 ?? 0;

    const successRate = ((result.requests.total - result.errors - result.non2xx) / result.requests.total) * 100;

    console.log("\n=== Contracts API Load Test Results ===");
    console.log(`Concurrent Connections: ${CONCURRENT_CONNECTIONS}`);
    console.log(`Duration: ${TEST_DURATION}s`);
    console.log(`Total Requests: ${result.requests.total}`);
    console.log(`RPS: ${result.requests.average.toFixed(2)}`);
    console.log(`Avg Latency: ${result.latency.average.toFixed(2)}ms`);
    console.log(`P95 Latency: ${p95.toFixed(2)}ms`);
    console.log(`P99 Latency: ${p99.toFixed(2)}ms`);
    console.log(`Errors: ${result.errors}`);
    console.log(`Non-2xx: ${result.non2xx}`);
    console.log(`Success Rate: ${successRate.toFixed(2)}%\n`);

    // Validate against official SLO definitions
    expect(result.errors).toBe(0);
    expect(result.non2xx).toBe(0);
    expect(successRate).toBeGreaterThanOrEqual(contractsSLO.targetSuccessRatePercent);
    expect(p95).toBeLessThan(contractsSLO.targetLatencyP95Ms);
    expect(p99).toBeLessThan(contractsSLO.targetLatencyP99Ms);
    
    // Minimum performance requirement
    expect(result.requests.average).toBeGreaterThanOrEqual(30);
  }, 30000); // 30s timeout for CI safety
});
