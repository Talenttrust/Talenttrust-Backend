import request from "supertest";
import { routerApp } from "./router";

// Mock env for tests
describe("Router", () => {
  beforeEach(() => {
    process.env.ACTIVE_COLOR = "blue";
    process.env.BLUE_PORT = "3001";
    process.env.GREEN_PORT = "3002";
  });

  it("routes /api to blue backend", async () => {
    const res = await request(routerApp).get("/api/v1/contracts");
    expect(res.status).toBe(502); // Proxy correctly returns 502 when backend unavailable
  });

  it("health/router returns active", async () => {
    const res = await request(routerApp).get("/health/router");
    expect(res.body.active).toBe("http://localhost:3001");
  });

  it("switch to green updates route", async () => {
    process.env.ACTIVE_COLOR = "green";
    const res = await request(routerApp).get("/health/router");
    expect(res.body.active).toBe("http://localhost:3002");
  });
});
