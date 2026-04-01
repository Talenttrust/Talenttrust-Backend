import autocannon from "autocannon";
import app from "../../index";
import { Server } from "http";

/**
 * Stress Test Suite
 * Pushes endpoints beyond normal load to find breaking points.
 * Security note: run only against local/staging — never production.
 */

let server: Server;

beforeAll((done) => {
  server = app.listen(3097, done); 
});

afterAll((done) => {
  server.close(done);
});
describe("Stress Test - All Critical Endpoints", () => {
  it("should degrade gracefully under spike load on /health", async () => {
    const result = await autocannon({
      url: "http://localhost:3097/health",
      connections: 100, // 100 concurrent — spike!
      duration: 20,
      method: "GET",
    });

    console.log("=== STRESS RESULTS /health ===");
    console.log(`RPS: ${result.requests.average}`);
    console.log(`p99 Latency: ${result.latency.p99}ms`);
    console.log(`Errors: ${result.errors}`);

    // Under stress, we still expect no crashes — errors should be minimal
    const errorRate = result.errors / result.requests.total;
    expect(errorRate).toBeLessThan(0.05); // less than 5% error rate
  }, 60000);

  it("should degrade gracefully under spike load on /api/v1/contracts", async () => {
    const result = await autocannon({
      url: "http://localhost:3097/api/v1/contracts",
      connections: 100,
      duration: 20,
      method: "GET",
    });

    const errorRate = result.errors / result.requests.total;
    expect(errorRate).toBeLessThan(0.05);
  }, 60000);
});
