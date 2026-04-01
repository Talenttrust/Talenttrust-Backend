import autocannon from "autocannon";
import app from "../../index";
import { Server } from "http";

/**
 * Load test for GET /api/v1/contracts
 * Baseline: 20 concurrent connections for 15 seconds
 */
describe("Load Test - GET /api/v1/contracts", () => {
  let server: Server;
  beforeAll((done) => {
    // Start a local server for testing
    server = app.listen(3098, done);
  });

  afterAll((done) => {
    server.close(done);
  });
  it("should serve contracts endpoint under load", async () => {
    const result = await autocannon({
      url: "http://localhost:3098/api/v1/contracts",
      connections: 20,
      duration: 15,
      method: "GET",
    });

    console.log(`RPS: ${result.requests.average}`);
    console.log(`Avg Latency: ${result.latency.average}ms`);
    console.log(`Errors: ${result.errors}`);

    expect(result.errors).toBe(0);
    expect(result.latency.p99).toBeLessThan(500); // 99th percentile under 500ms
  }, 40000);
});
